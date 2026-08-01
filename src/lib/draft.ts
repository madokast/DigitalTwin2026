import { assertNoReservedTags, validateTags } from '@/lib/tags'
import { parseRFC3339Flexible } from '@/lib/timeutil'

/** ISO 8601 末尾时区：Z / ±HH:MM / ±HHMM（与 query `from`/`to`、Go draft 一致） */
const ISO_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i

/** 十进制字面量：无科学计数、无前导 +、无前导零、须有整数部 */
const DECIMAL_STRING = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

const VALUE_NUMBER_MAX_LEN = 40
const VALUE_NUMBER_MAX_INT_DIGITS = 28
const VALUE_NUMBER_MAX_FRAC_DIGITS = 10

export const VALUE_NUMBER_MUST_BE_STRING =
  'value_number must be a decimal string'

export type RecordDraftBody = {
  happened_at?: unknown
  value_number?: unknown
  value_text?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
}

export type NormalizedRecordDraft = {
  happenedAt: Date
  valueNumber: string | null
  valueText: string | null
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
 * log/number、log/text 与 parseRecordDraft 共用。
 */
export function parseHappenedAt(
  raw: unknown,
): { ok: true; value: Date } | DraftValidationError {
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
  return { ok: true, value: happenedAt }
}

/**
 * 校验已 trim 的十进制字符串字面量（不经 Number 往返）。
 * 与 Go draft.ValidateDecimalString 规则一致；边界样例见 testdata/decimal-string-cases.json。
 */
export function validateDecimalString(
  s: string,
): { ok: true } | DraftValidationError {
  if (s.length > VALUE_NUMBER_MAX_LEN || !DECIMAL_STRING.test(s)) {
    return { error: 'Invalid value_number' }
  }
  const unsigned = s.startsWith('-') ? s.slice(1) : s
  const [intPart, fracPart = ''] = unsigned.split('.')
  if (
    intPart.length > VALUE_NUMBER_MAX_INT_DIGITS ||
    fracPart.length > VALUE_NUMBER_MAX_FRAC_DIGITS
  ) {
    return { error: 'Invalid value_number' }
  }
  return { ok: true }
}

/**
 * value_number：仅接受 string | null；JSON number → 明确 400。
 * trim 后空串 → null（PATCH/draft）；非空则校验并保留字面量。
 */
export function parseValueNumber(
  raw: unknown,
): { ok: true; value: string | null } | DraftValidationError {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null }
  }
  if (typeof raw === 'number') {
    return { error: VALUE_NUMBER_MUST_BE_STRING }
  }
  if (typeof raw !== 'string') {
    return { error: 'Invalid value_number' }
  }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  const check = validateDecimalString(trimmed)
  if ('error' in check) return check
  return { ok: true, value: trimmed }
}

/**
 * 校验并可编辑字段快照归一化（前后端共用）。
 * 空串在可空字段上变为 null；objective_context 不允许空。
 */
export function parseRecordDraft(
  body: RecordDraftBody,
): NormalizedRecordDraft | DraftValidationError {
  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) return happenedResult
  const happenedAt = happenedResult.value

  const numberResult = parseValueNumber(body.value_number)
  if ('error' in numberResult) return numberResult
  const valueNumber = numberResult.value

  let valueText: string | null = null
  if (body.value_text !== null && body.value_text !== undefined) {
    if (typeof body.value_text !== 'string') {
      return { error: 'Invalid value_text' }
    }
    valueText = emptyStringToNull(body.value_text)
  }

  if (valueNumber === null && valueText === null) {
    return { error: 'value_number and value_text cannot both be null' }
  }

  if (!Array.isArray(body.tags) || body.tags.length === 0) {
    return { error: 'Missing required field: tags (non-empty array)' }
  }
  if (!body.tags.every((t) => typeof t === 'string')) {
    return { error: 'tags must be an array of strings' }
  }
  const tagsValidation = validateTags(body.tags)
  if (!tagsValidation.valid) {
    return { error: tagsValidation.error ?? 'Invalid tags' }
  }
  const reserved = assertNoReservedTags(body.tags)
  if (!reserved.valid) {
    return { error: reserved.error! }
  }

  if (
    typeof body.objective_context !== 'string' ||
    body.objective_context === ''
  ) {
    return { error: 'Missing required field: objective_context' }
  }

  let subjectiveInterpretation: string | null = null
  if (
    body.subjective_interpretation !== null &&
    body.subjective_interpretation !== undefined
  ) {
    if (typeof body.subjective_interpretation !== 'string') {
      return { error: 'Invalid subjective_interpretation' }
    }
    subjectiveInterpretation = emptyStringToNull(body.subjective_interpretation)
  }

  return {
    happenedAt,
    valueNumber,
    valueText,
    tags: body.tags,
    objectiveContext: body.objective_context,
    subjectiveInterpretation,
  }
}
