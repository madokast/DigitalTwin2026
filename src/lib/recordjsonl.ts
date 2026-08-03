/**
 * Record JSONL 行编解码 / 校验（与 Go `recordjsonl` 同构）。
 *
 * 表示层 = OpenAPI Record snake_case；禁止 Todo deform 键（created_at / content）。
 * 语义对齐 draft（时间 / 小数 / 双 null / tags 格式），但 tags 在文件中为**字符串化** JSON 数组。
 *
 * **不**调用 `assertNoReservedTags`：import 须可写保留 tag；若调用方（如未来非 import 路径）
 * 需拒绝保留 tag，自行在 parse 成功后调用 `assertNoReservedTags(row.tags)`。
 */

import {
  emptyStringToNull,
  parseHappenedAt,
  parseValueNumber,
} from '@/lib/draft'
import {
  formatHappenedAt,
  isValidRecordId,
  INVALID_RECORD_ID,
  tagsJSON,
  type Record as ApiRecord,
} from '@/lib/record'
import { TAGS_NOT_JSON_ARRAY, validateTags } from '@/lib/tags'
import {
  BODY_MUST_BE_OBJECT,
  rejectUnknownKeys,
  UNKNOWN_JSON_KEY_PREFIX,
} from '@/lib/unknown-keys'

/** OpenAPI Record 键（snake_case）；未知键含 deform → Unknown JSON key */
export const RECORD_JSONL_KEYS = [
  'id',
  'happened_at',
  'value_number',
  'value_text',
  'tags',
  'objective_context',
  'subjective_interpretation',
] as const

/** 非法 JSON 行（与 HTTP `Invalid JSON body` 区分） */
export const INVALID_JSON_LINE = 'Invalid JSON line'

/** tags 误传 JSON 数组类型（Record 要求 string） */
export const TAGS_MUST_BE_STRINGIFIED_ARRAY =
  'tags must be a stringified JSON array'

/** tags 字符串无法 JSON.parse */
export const INVALID_TAGS_JSON = 'Invalid tags JSON'

const UTF8_BOM = '\uFEFF'

/** 领域行：parse 产出；serialize 输入（内部字段名可 camelCase） */
export type RecordJsonlRow = {
  id: string
  happenedAt: Date
  valueNumber: string | null
  valueText: string | null
  tags: string[]
  objectiveContext: string
  subjectiveInterpretation: string | null
}

export type RecordJsonlError = { error: string }

/**
 * 可选行号包装：`line N: …`（1-based）。未传或 <1 时原样返回。
 * 与 Go `FormatLineError` 同构。
 */
export function formatLineError(
  message: string,
  lineNumber?: number,
): string {
  if (lineNumber !== undefined && lineNumber >= 1) {
    return `line ${lineNumber}: ${message}`
  }
  return message
}

function fail(
  message: string,
  lineNumber?: number,
): RecordJsonlError {
  return { error: formatLineError(message, lineNumber) }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * 解析一行 JSONL（可含前导 BOM；首尾空白 trim）。
 * 成功 → 领域行；失败 → `{ error }`（英文；可含行号前缀）。
 */
export function parseLine(
  rawLine: string,
  lineNumber?: number,
): RecordJsonlRow | RecordJsonlError {
  let line = rawLine
  if (line.startsWith(UTF8_BOM)) {
    line = line.slice(1)
  }
  line = line.trim()
  if (line === '') {
    return fail(INVALID_JSON_LINE, lineNumber)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return fail(INVALID_JSON_LINE, lineNumber)
  }

  const unknown = rejectUnknownKeys(parsed, RECORD_JSONL_KEYS)
  if (unknown) {
    // rejectUnknownKeys 对非 object 返回 BODY_MUST_BE_OBJECT
    return fail(unknown.error, lineNumber)
  }

  const body = parsed as { [key: string]: unknown }

  for (const key of RECORD_JSONL_KEYS) {
    if (!hasOwn(body, key)) {
      return fail(`Missing required field: ${key}`, lineNumber)
    }
  }

  if (typeof body.id !== 'string' || body.id === '') {
    return fail(INVALID_RECORD_ID, lineNumber)
  }
  if (!isValidRecordId(body.id)) {
    return fail(INVALID_RECORD_ID, lineNumber)
  }

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) {
    return fail(happenedResult.error, lineNumber)
  }

  const numberResult = parseValueNumber(body.value_number)
  if ('error' in numberResult) {
    return fail(numberResult.error, lineNumber)
  }
  const valueNumber = numberResult.value

  let valueText: string | null = null
  if (body.value_text !== null) {
    if (typeof body.value_text !== 'string') {
      return fail('Invalid value_text', lineNumber)
    }
    valueText = emptyStringToNull(body.value_text)
  }

  if (valueNumber === null && valueText === null) {
    return fail(
      'value_number and value_text cannot both be null',
      lineNumber,
    )
  }

  if (Array.isArray(body.tags)) {
    return fail(TAGS_MUST_BE_STRINGIFIED_ARRAY, lineNumber)
  }
  if (typeof body.tags !== 'string') {
    return fail(TAGS_MUST_BE_STRINGIFIED_ARRAY, lineNumber)
  }

  let tagsParsed: unknown
  try {
    tagsParsed = JSON.parse(body.tags)
  } catch {
    return fail(INVALID_TAGS_JSON, lineNumber)
  }
  if (!Array.isArray(tagsParsed)) {
    return fail(TAGS_NOT_JSON_ARRAY, lineNumber)
  }
  if (!tagsParsed.every((t) => typeof t === 'string')) {
    return fail('tags must be an array of strings', lineNumber)
  }
  const tags = tagsParsed as string[]
  const tagsValidation = validateTags(tags)
  if (!tagsValidation.valid) {
    return fail(tagsValidation.error ?? 'Invalid tags', lineNumber)
  }
  // 故意不调用 assertNoReservedTags（见文件头注释）

  if (
    typeof body.objective_context !== 'string' ||
    body.objective_context === ''
  ) {
    return fail('Missing required field: objective_context', lineNumber)
  }

  let subjectiveInterpretation: string | null = null
  if (body.subjective_interpretation !== null) {
    if (typeof body.subjective_interpretation !== 'string') {
      return fail('Invalid subjective_interpretation', lineNumber)
    }
    subjectiveInterpretation = emptyStringToNull(
      body.subjective_interpretation,
    )
  }

  return {
    id: body.id,
    happenedAt: happenedResult.value,
    valueNumber,
    valueText,
    tags,
    objectiveContext: body.objective_context,
    subjectiveInterpretation,
  }
}

/**
 * 领域行 → 一行 JSONL（无尾换行；happened_at 为 UTC Z；tags 为字符串化数组）。
 * 键序固定，与 Go SerializeLine 一致。
 */
export function serializeLine(row: RecordJsonlRow): string {
  return serializeRecord({
    id: row.id,
    happened_at: formatHappenedAt(row.happenedAt),
    value_number: row.valueNumber,
    value_text: row.valueText,
    tags: tagsJSON(row.tags),
    objective_context: row.objectiveContext,
    subjective_interpretation: row.subjectiveInterpretation,
  })
}

/**
 * 已是 API Record 形状时直接序列化（导出路径）；键序与 SerializeLine 一致。
 */
export function serializeRecord(rec: ApiRecord): string {
  return JSON.stringify({
    id: rec.id,
    happened_at: rec.happened_at,
    value_number: rec.value_number,
    value_text: rec.value_text,
    tags: rec.tags,
    objective_context: rec.objective_context,
    subjective_interpretation: rec.subjective_interpretation,
  })
}

// 再导出前缀常量，便于测试对照
export { UNKNOWN_JSON_KEY_PREFIX, BODY_MUST_BE_OBJECT }
