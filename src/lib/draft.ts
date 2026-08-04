import { parseRFC3339Flexible } from '@/lib/timeutil'
import { extractUtcOffsetLiteral } from '@/lib/utcoffset'

/** ISO 8601 末尾时区：Z / ±HH:MM / ±HHMM（与 query `from`/`to`、Go draft 一致） */
const ISO_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i

/** 十进制字面量：无科学计数、无前导 +、无前导零、须有整数部 */
const DECIMAL_STRING = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

const NUMERIC_VALUE_MAX_LEN = 40
const NUMERIC_VALUE_MAX_INT_DIGITS = 28
const NUMERIC_VALUE_MAX_FRAC_DIGITS = 10

export const NUMERIC_VALUE_MUST_BE_STRING =
  'numeric_value must be a decimal string'

export type DraftValidationError = { error: string }

/** 空串 → null；其它字符串原样；null/undefined → null */
export function emptyStringToNull(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === '') return null
  return value
}

/**
 * 校验 happened_at：必须带显式时区（Z 或 ±HH:MM / ±HHMM），与 query 一致。
 * 同时抽出规范 utc_offset（创建路径写隐列）。
 * log/number、log/text、body/weight、todo 共用。
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
 * trim 后空串 → null；非空则校验并保留字面量。
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

/** 可空文本（ai_analysis）：不传 / null → null；非 string → Invalid；空串或空白串 → must not be blank；存 trim 后值 */
export function optionalTrimmedNullable(
  raw: unknown,
  field: 'ai_analysis',
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

