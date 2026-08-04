/**
 * Record JSONL 行编解码 / 校验（与 Go `recordjsonl` 同构）。
 *
 * 表示层 = OpenAPI Record snake_case；禁止 Todo deform 键（created_at / content）。
 * 语义对齐 draft（时间 / 小数 / 双 null / tags 格式）。tags 在文件中为 JSON **数组**
 * （与 JSON API 一致）；parse 兼容旧备份的字符串化 JSON 数组。
 *
 * **不**调用 `assertNoReservedTags`：import 须可写保留 tag；若调用方（如未来非 import 路径）
 * 需拒绝保留 tag，自行在 parse 成功后调用 `assertNoReservedTags(row.tags)`。
 */

import {
  optionalTrimmedNullable,
  parseHappenedAt,
  parseNumericValue,
  requireTrimmedText,
} from '@/lib/draft'
import {
  isValidRecordId,
  INVALID_RECORD_ID,
  type Record as ApiRecord,
} from '@/lib/record'
import { formatHappenedAt } from '@/lib/utcoffset'
import { validateTags } from '@/lib/tags'
import {
  BODY_MUST_BE_OBJECT,
  rejectUnknownKeys,
  UNKNOWN_JSON_KEY_PREFIX,
} from '@/lib/unknown-keys'

/** OpenAPI Record 键（snake_case）；未知键含 deform → Unknown JSON key */
export const RECORD_JSONL_KEYS = [
  'id',
  'happened_at',
  'numeric_value',
  'raw_content',
  'tags',
  'objective_context',
  'subjective_interpretation',
] as const

/** 非法 JSON 行（与 HTTP `Invalid JSON body` 区分） */
export const INVALID_JSON_LINE = 'Invalid JSON line'

/** tags 类型非法（既非字符串化 JSON 数组，也非 JSON 数组） */
export const INVALID_TAGS = 'Invalid tags'

/** tags 字符串无法 JSON.parse */
export const INVALID_TAGS_JSON = 'Invalid tags JSON'

const UTF8_BOM = '\uFEFF'

/** 领域行：parse 产出；serialize 输入（内部字段名可 camelCase） */
export type RecordJsonlRow = {
  id: string
  happenedAt: Date
  utcOffset: string
  numericValue: string | null
  rawContent: string | null
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

  // 除 numeric_value 外全部 required：numeric_value 可省略（= null；双 null 校验在下方）
  for (const key of RECORD_JSONL_KEYS) {
    if (key === 'numeric_value') continue
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

  const numberResult = parseNumericValue(body.numeric_value)
  if ('error' in numberResult) {
    return fail(numberResult.error, lineNumber)
  }
  const numericValue = numberResult.value

  let rawContent: string | null = null
  if (body.raw_content !== null) {
    const rc = requireTrimmedText(body.raw_content, 'raw_content')
    if ('error' in rc) {
      return fail(rc.error, lineNumber)
    }
    rawContent = rc.value
  }

  if (numericValue === null && rawContent === null) {
    return fail(
      'numeric_value and raw_content cannot both be null',
      lineNumber,
    )
  }

  // tags 双兼容：字符串化 JSON 数组（旧备份）或 JSON 数组（新格式）
  let tagsRaw: unknown = body.tags
  if (typeof tagsRaw === 'string') {
    try {
      tagsRaw = JSON.parse(tagsRaw)
    } catch {
      return fail(INVALID_TAGS_JSON, lineNumber)
    }
  }
  if (!Array.isArray(tagsRaw)) {
    return fail(INVALID_TAGS, lineNumber)
  }
  if (!tagsRaw.every((t) => typeof t === 'string')) {
    return fail('tags must be an array of strings', lineNumber)
  }
  const tags = tagsRaw as string[]
  const tagsValidation = validateTags(tags)
  if (!tagsValidation.valid) {
    return fail(tagsValidation.error ?? 'Invalid tags', lineNumber)
  }
  // 故意不调用 assertNoReservedTags（见文件头注释）

  const objCtx = requireTrimmedText(body.objective_context, 'objective_context')
  if ('error' in objCtx) {
    return fail(objCtx.error, lineNumber)
  }

  const subjective = optionalTrimmedNullable(
    body.subjective_interpretation,
    'subjective_interpretation',
  )
  if ('error' in subjective) {
    return fail(subjective.error, lineNumber)
  }

  return {
    id: body.id,
    happenedAt: happenedResult.value,
    utcOffset: happenedResult.utcOffset,
    numericValue,
    rawContent,
    tags,
    objectiveContext: objCtx.value,
    subjectiveInterpretation: subjective.value,
  }
}

/**
 * 领域行 → 一行 JSONL（无尾换行；happened_at 按 utc_offset 带区；tags 为数组；
 * numeric_value 为 null 时键省略）。
 * 键序固定，与 Go SerializeLine 一致。
 */
export function serializeLine(row: RecordJsonlRow): string {
  return serializeRecord({
    id: row.id,
    happened_at: formatHappenedAt(row.happenedAt, row.utcOffset),
    ...(row.numericValue !== null ? { numeric_value: row.numericValue } : {}),
    raw_content: row.rawContent,
    tags: row.tags,
    objective_context: row.objectiveContext,
    subjective_interpretation: row.subjectiveInterpretation,
  })
}

/**
 * 已是 API Record 形状时直接序列化（导出路径）；键序与 SerializeLine 一致。
 * numeric_value 为 null 时键省略。
 */
export function serializeRecord(rec: ApiRecord): string {
  return JSON.stringify({
    id: rec.id,
    happened_at: rec.happened_at,
    ...(rec.numeric_value !== undefined && rec.numeric_value !== null
      ? { numeric_value: rec.numeric_value }
      : {}),
    raw_content: rec.raw_content,
    tags: rec.tags,
    objective_context: rec.objective_context,
    subjective_interpretation: rec.subjective_interpretation,
  })
}

// 再导出前缀常量，便于测试对照
export { UNKNOWN_JSON_KEY_PREFIX, BODY_MUST_BE_OBJECT }
