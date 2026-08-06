/**
 * 体重录入纯解析（与 faas/internal/bodyweightdraft 同构）。
 * 单位约定 kg；落库 tags 始终以保留前缀 `body:weight` 开头。
 */
import {
  optionalTrimmedNullable,
  parseHappenedAt,
  NUMERIC_VALUE_MUST_BE_STRING,
  requireTrimmedText,
  type DraftValidationError,
} from '@/lib/draft'
import {
  firstDuplicateTag,
  isValidTag,
  RESERVED_TAG_BODY_WEIGHT,
  assertNoReservedTags,
} from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'
import { normalizeMoneyAmount2 } from '@/lib/transactiondraft'

export const LOG_BODY_WEIGHT_KEYS = [
  'happened_at',
  'numeric_value',
  'objective_context',
  'ai_analysis',
  'tags',
] as const

/** 体重形态：正数、至多 3 位整数或至多两位小数；禁 +、负号、空格、残缺点、前导零 */
const WEIGHT_AMOUNT = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/

export const INVALID_WEIGHT =
  'invalid weight: positive decimal string from 1.00 to 500.00 inclusive, at most 2 fractional digits, no spaces; e.g. 75, 75.5, 75.50'

const WEIGHT_MIN_CENTS = 100 // 1.00
const WEIGHT_MAX_CENTS = 50000 // 500.00

export type LogBodyWeightBody = {
  happened_at?: unknown
  numeric_value?: unknown
  objective_context?: unknown
  ai_analysis?: unknown
  tags?: unknown
}

export type NormalizedBodyWeight = {
  /** 已校验的 happened_at 请求串（Repository 内解析落库） */
  happenedAtRaw: string
  numericValue: string
  tags: string[]
  objectiveContext: string
  aiAnalysis: string | null
}

/** 已通过体重正则并规范为两位小数的字面量是否在 [1.00, 500.00] */
export function weightCentsInRange(normalized2: string): boolean {
  const [intPart, fracPart] = normalized2.split('.')
  const cents = Number(intPart) * 100 + Number(fracPart)
  return cents >= WEIGHT_MIN_CENTS && cents <= WEIGHT_MAX_CENTS
}

/**
 * 解析体重 numeric_value：JSON number → numeric_value must be a decimal string；
 * 形态 / 范围 → INVALID_WEIGHT；通过后规范为两位小数。
 */
export function parseWeightAmount(
  raw: unknown,
): { ok: true; value: string } | DraftValidationError {
  if (raw === undefined || raw === null) {
    return { error: 'missing required field: numeric_value' }
  }
  if (typeof raw === 'number') {
    return { error: NUMERIC_VALUE_MUST_BE_STRING }
  }
  if (typeof raw !== 'string') {
    return { error: INVALID_WEIGHT }
  }
  // trim 后校验；存 trim 后值（与 numeric_value 一致）
  const trimmed = raw.trim()
  if (!WEIGHT_AMOUNT.test(trimmed)) {
    return { error: INVALID_WEIGHT }
  }
  const stored = normalizeMoneyAmount2(trimmed)
  if (!weightCentsInRange(stored)) {
    return { error: INVALID_WEIGHT }
  }
  return { ok: true, value: stored }
}

/**
 * 可选额外 tags：省略 / null → []；[] 合法；非空则校验格式并拒保留前缀。
 */
function parseOptionalClientTags(
  raw: unknown,
): { ok: true; value: string[] } | DraftValidationError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] }
  }
  if (!Array.isArray(raw)) {
    return { error: 'tags must be an array of strings' }
  }
  if (!raw.every((t) => typeof t === 'string')) {
    return { error: 'tags must be an array of strings' }
  }
  const list = raw as string[]
  if (list.length === 0) {
    return { ok: true, value: [] }
  }
  for (const tag of list) {
    if (!isValidTag(tag)) {
      return {
        error: `invalid tag: "${tag}". Tags must contain only letters, numbers, underscores, and cannot start with a number.`,
      }
    }
  }
  const reserved = assertNoReservedTags(list)
  if (!reserved.valid) {
    return { error: reserved.error! }
  }
  const dup = firstDuplicateTag(list)
  if (dup !== null) {
    return { error: `duplicate tag "${dup}"` }
  }
  return { ok: true, value: list }
}

/**
 * 校验整单体重请求；落库 tags = [body:weight, ...clientTags]。
 */
export function parseBodyWeight(
  body: LogBodyWeightBody,
): NormalizedBodyWeight | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_BODY_WEIGHT_KEYS)
  if (unknown) {
    return { error: unknown.error }
  }

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) {
    return { error: happenedResult.error }
  }
  const happenedAtRaw = body.happened_at as string

  const amount = parseWeightAmount(body.numeric_value)
  if ('error' in amount) {
    return { error: amount.error }
  }

  const objCtxResult = requireTrimmedText(
    body.objective_context,
    'objective_context',
  )
  if ('error' in objCtxResult) {
    return { error: objCtxResult.error }
  }

  const aiAnalysis = optionalTrimmedNullable(
    body.ai_analysis,
    'ai_analysis',
  )
  if ('error' in aiAnalysis) {
    return { error: aiAnalysis.error }
  }

  const clientTags = parseOptionalClientTags(body.tags)
  if ('error' in clientTags) {
    return { error: clientTags.error }
  }

  return {
    happenedAtRaw,
    numericValue: amount.value,
    tags: [RESERVED_TAG_BODY_WEIGHT, ...clientTags.value],
    objectiveContext: objCtxResult.value,
    aiAnalysis: aiAnalysis.value,
  }
}
