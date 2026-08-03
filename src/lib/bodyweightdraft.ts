/**
 * 体重录入纯解析（与 faas/internal/bodyweightdraft 同构）。
 * 单位约定 kg；落库 tags 始终以保留前缀 `body:weight` 开头。
 */
import {
  parseHappenedAt,
  VALUE_NUMBER_MUST_BE_STRING,
  type DraftValidationError,
} from '@/lib/draft'
import {
  isValidTag,
  RESERVED_TAG_BODY_WEIGHT,
  assertNoReservedTags,
} from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'
import { normalizeMoneyAmount2 } from '@/lib/transactiondraft'

export const LOG_BODY_WEIGHT_KEYS = [
  'happened_at',
  'value_number',
  'objective_context',
  'subjective_interpretation',
  'tags',
] as const

/** 体重形态：正数、至多 3 位整数或至多两位小数；禁 +、负号、空格、残缺点、前导零 */
const WEIGHT_AMOUNT = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/

export const INVALID_WEIGHT =
  'Invalid weight: positive decimal string from 1.00 to 500.00 inclusive, at most 2 fractional digits, no spaces; e.g. 75, 75.5, 75.50'

const WEIGHT_MIN_CENTS = 100 // 1.00
const WEIGHT_MAX_CENTS = 50000 // 500.00

export type LogBodyWeightBody = {
  happened_at?: unknown
  value_number?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
  tags?: unknown
}

export type NormalizedBodyWeight = {
  happenedAt: Date
  valueNumber: string
  tags: string[]
  objectiveContext: string
  subjectiveInterpretation: string | null
}

/** 已通过体重正则并规范为两位小数的字面量是否在 [1.00, 500.00] */
export function weightCentsInRange(normalized2: string): boolean {
  const [intPart, fracPart] = normalized2.split('.')
  const cents = Number(intPart) * 100 + Number(fracPart)
  return cents >= WEIGHT_MIN_CENTS && cents <= WEIGHT_MAX_CENTS
}

/**
 * 解析体重 value_number：JSON number → value_number must be a decimal string；
 * 形态 / 范围 → INVALID_WEIGHT；通过后规范为两位小数。
 */
export function parseWeightAmount(
  raw: unknown,
): { ok: true; value: string } | DraftValidationError {
  if (raw === undefined || raw === null) {
    return { error: 'Missing required field: value_number' }
  }
  if (typeof raw === 'number') {
    return { error: VALUE_NUMBER_MUST_BE_STRING }
  }
  if (typeof raw !== 'string') {
    return { error: INVALID_WEIGHT }
  }
  // 禁止 trim：有空格 / 空串均走统一 Invalid weight
  if (!WEIGHT_AMOUNT.test(raw)) {
    return { error: INVALID_WEIGHT }
  }
  const stored = normalizeMoneyAmount2(raw)
  if (!weightCentsInRange(stored)) {
    return { error: INVALID_WEIGHT }
  }
  return { ok: true, value: stored }
}

function optionalSubjective(
  raw: unknown,
): { value: string | null } | DraftValidationError {
  if (raw === undefined || raw === null || raw === '') {
    return { value: null }
  }
  if (typeof raw !== 'string') {
    return { error: 'Invalid subjective_interpretation' }
  }
  return { value: raw }
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
        error: `Invalid tag: "${tag}". Tags must contain only letters, numbers, underscores, and cannot start with a number.`,
      }
    }
  }
  const reserved = assertNoReservedTags(list)
  if (!reserved.valid) {
    return { error: reserved.error! }
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

  const amount = parseWeightAmount(body.value_number)
  if ('error' in amount) {
    return { error: amount.error }
  }

  if (!body.objective_context || typeof body.objective_context !== 'string') {
    return { error: 'Missing required field: objective_context' }
  }

  const subjective = optionalSubjective(body.subjective_interpretation)
  if ('error' in subjective) {
    return { error: subjective.error }
  }

  const clientTags = parseOptionalClientTags(body.tags)
  if ('error' in clientTags) {
    return { error: clientTags.error }
  }

  return {
    happenedAt: happenedResult.value,
    valueNumber: amount.value,
    tags: [RESERVED_TAG_BODY_WEIGHT, ...clientTags.value],
    objectiveContext: body.objective_context,
    subjectiveInterpretation: subjective.value,
  }
}
