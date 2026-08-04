import { assertNoReservedTags, validateTags } from '@/lib/tags'
import { parseRFC3339Flexible } from '@/lib/timeutil'
import { rejectUnknownKeys } from '@/lib/unknown-keys'
import { extractUtcOffsetLiteral } from '@/lib/utcoffset'

export const RECORD_DRAFT_KEYS = [
  'happened_at',
  'numeric_value',
  'raw_content',
  'tags',
  'objective_context',
  'subjective_interpretation',
] as const

/** ISO 8601 末尾时区：Z / ±HH:MM / ±HHMM（与 query `from`/`to`、Go draft 一致） */
const ISO_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i

/** 十进制字面量：无科学计数、无前导 +、无前导零、须有整数部 */
const DECIMAL_STRING = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

const NUMERIC_VALUE_MAX_LEN = 40
const NUMERIC_VALUE_MAX_INT_DIGITS = 28
const NUMERIC_VALUE_MAX_FRAC_DIGITS = 10

export const NUMERIC_VALUE_MUST_BE_STRING =
  'numeric_value must be a decimal string'

export type RecordDraftBody = {
  happened_at?: unknown
  numeric_value?: unknown
  raw_content?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
}

export type NormalizedRecordDraft = {
  /**
   * 请求带 `happened_at` 时为解析后的瞬间；省略则为 null。
   * Update：非 null 时与 utcOffset 一并写入；null 时两列都不动（§7）。
   */
  happenedAt: Date | null
  /** 与 happenedAt 同生同灭；规范 utc_offset 字面量 */
  utcOffset: string | null
  numericValue: string | null
  rawContent: string | null
  tags: string[]
  objectiveContext: string
  subjectiveInterpretation: string | null
}

export type DraftValidationError = { error: string }

/** 空串 → null；其它字符串原样；null/undefined → null */
export function emptyStringToNull(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === '') return null
  return value
}

/**
 * 校验 happened_at：必须带显式时区（Z 或 ±HH:MM / ±HHMM），与 PATCH / query 一致。
 * 同时抽出规范 utc_offset（创建路径写隐列；PATCH 见 parseRecordDraft / Update §7）。
 * log/number、log/text 与 parseRecordDraft 共用。
 */
export function parseHappenedAt(
  raw: unknown,
): { ok: true; value: Date; utcOffset: string } | DraftValidationError {
  if (typeof raw !== 'string' || !raw) {
    return { error: 'Missing required field: happened_at' }
  }
  if (!ISO_TZ_SUFFIX.test(raw)) {
    return {
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    }
  }
  const happenedAt = parseRFC3339Flexible(raw)
  if (!happenedAt) {
    return { error: 'Invalid happened_at datetime' }
  }
  const offset = extractUtcOffsetLiteral(raw)
  if (!('ok' in offset)) {
    return { error: offset.error }
  }
  return { ok: true, value: happenedAt, utcOffset: offset.value }
}

/**
 * 校验已 trim 的十进制字符串字面量（不经 Number 往返）。
 * 与 Go draft.ValidateDecimalString 规则一致；边界样例见 testdata/decimal-string-cases.json。
 * 长度用 string.length（UTF-16）；Go 用 utf8.RuneCountInString。DECIMAL_STRING 仅 ASCII，
 * 合法字面量下二者相等（api-layering §1.1）。
 */
export function validateDecimalString(
  s: string,
): { ok: true } | DraftValidationError {
  if (s.length > NUMERIC_VALUE_MAX_LEN || !DECIMAL_STRING.test(s)) {
    return { error: 'Invalid numeric_value' }
  }
  const unsigned = s.startsWith('-') ? s.slice(1) : s
  const [intPart, fracPart = ''] = unsigned.split('.')
  if (
    intPart.length > NUMERIC_VALUE_MAX_INT_DIGITS ||
    fracPart.length > NUMERIC_VALUE_MAX_FRAC_DIGITS
  ) {
    return { error: 'Invalid numeric_value' }
  }
  return { ok: true }
}

/**
 * numeric_value：仅接受 string | null；JSON number → 明确 400。
 * trim 后空串 → null（PATCH/draft）；非空则校验并保留字面量。
 */
export function parseNumericValue(
  raw: unknown,
): { ok: true; value: string | null } | DraftValidationError {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null }
  }
  if (typeof raw === 'number') {
    return { error: NUMERIC_VALUE_MUST_BE_STRING }
  }
  if (typeof raw !== 'string') {
    return { error: 'Invalid numeric_value' }
  }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  const check = validateDecimalString(trimmed)
  if ('error' in check) return check
  return { ok: true, value: trimmed }
}

function hasOwnKey(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** 必填文本（raw_content / objective_context / content / memo）：缺失或空串或非 string → Missing；空白串 → must not be blank；存 trim 后值 */
export function requireTrimmedText(
  raw: unknown,
  field: 'raw_content' | 'objective_context' | 'content' | 'memo',
): { ok: true; value: string } | DraftValidationError {
  if (typeof raw !== 'string' || raw === '') {
    return { error: `Missing required field: ${field}` }
  }
  if (raw.trim() === '') {
    return { error: `${field} must not be blank` }
  }
  return { ok: true, value: raw.trim() }
}

/** 可空文本（subjective_interpretation）：不传 / null → null；非 string → Invalid；空串或空白串 → must not be blank；存 trim 后值 */
export function optionalTrimmedNullable(
  raw: unknown,
  field: 'subjective_interpretation',
): { ok: true; value: string | null } | DraftValidationError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string') {
    return { error: `Invalid ${field}` }
  }
  if (raw.trim() === '') {
    return { error: `${field} must not be blank` }
  }
  return { ok: true, value: raw.trim() }
}

/**
 * 校验并可编辑字段快照归一化（前后端共用；Admin PATCH）。
 * 文本字段 trim 后入库；空串 / 空白串拒绝（清空用显式 null）；objective_context 不允许空。
 * `happened_at` 可省略（§7：两列都不动）；带则解析瞬间并抽出 utc_offset。
 */
export function parseRecordDraft(
  body: RecordDraftBody,
): NormalizedRecordDraft | DraftValidationError {
  const unknown = rejectUnknownKeys(body, RECORD_DRAFT_KEYS)
  if (unknown) return unknown

  let happenedAt: Date | null = null
  let utcOffset: string | null = null
  if (hasOwnKey(body, 'happened_at')) {
    const happenedResult = parseHappenedAt(body.happened_at)
    if ('error' in happenedResult) return happenedResult
    happenedAt = happenedResult.value
    utcOffset = happenedResult.utcOffset
  }

  const numberResult = parseNumericValue(body.numeric_value)
  if ('error' in numberResult) return numberResult
  const numericValue = numberResult.value

  let rawContent: string | null = null
  if (body.raw_content !== null && body.raw_content !== undefined) {
    const rc = requireTrimmedText(body.raw_content, 'raw_content')
    if ('error' in rc) return rc
    rawContent = rc.value
  }

  if (numericValue === null && rawContent === null) {
    return { error: 'numeric_value and raw_content cannot both be null' }
  }

  let tagList: string[]
  if (body.tags === undefined || body.tags === null) {
    tagList = []
  } else if (Array.isArray(body.tags)) {
    if (!body.tags.every((t) => typeof t === 'string')) {
      return { error: 'tags must be an array of strings' }
    }
    tagList = body.tags
  } else {
    return { error: 'tags must be an array of strings' }
  }
  const tagsValidation = validateTags(tagList)
  if (!tagsValidation.valid) {
    return { error: tagsValidation.error ?? 'Invalid tags' }
  }
  const reserved = assertNoReservedTags(tagList)
  if (!reserved.valid) {
    return { error: reserved.error! }
  }

  const objCtx = requireTrimmedText(body.objective_context, 'objective_context')
  if ('error' in objCtx) return objCtx

  const subjective = optionalTrimmedNullable(
    body.subjective_interpretation,
    'subjective_interpretation',
  )
  if ('error' in subjective) return subjective

  return {
    happenedAt,
    utcOffset,
    numericValue,
    rawContent,
    tags: tagList,
    objectiveContext: objCtx.value,
    subjectiveInterpretation: subjective.value,
  }
}
