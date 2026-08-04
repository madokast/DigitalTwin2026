import { parseHappenedAt, requireTrimmedText, optionalTrimmedNullable } from '@/lib/draft'
import { validateTags, assertNoReservedTags } from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'
import type { DraftValidationError } from '@/lib/draft'

/**
 * 复盘记录纯解析与落库 tags 组装（与 faas/internal/reviewdraft 同构）。
 * 落库 tags = [review:{cadence}, ...clientTags]；客户端不得传 review:*（保留前缀）。
 */

export const REVIEW_CADENCES = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'semiannually',
  'yearly',
] as const

export type ReviewCadence = (typeof REVIEW_CADENCES)[number]

export const LOG_REVIEW_KEYS = [
  'happened_at',
  'cadence',
  'raw_content',
  'tags',
  'objective_context',
  'ai_analysis',
] as const

export const INVALID_CADENCE_MESSAGE =
  'Invalid cadence: must be one of daily, weekly, monthly, quarterly, semiannually, yearly'

export const MISSING_CADENCE_MESSAGE = 'Missing required field: cadence'

export type LogReviewBody = {
  happened_at?: unknown
  cadence?: unknown
  raw_content?: unknown
  tags?: unknown
  objective_context?: unknown
  ai_analysis?: unknown
}

export type NormalizedReview = {
  happenedAt: Date
  utcOffset: string
  cadence: ReviewCadence
  rawContent: string
  objectiveContext: string
  aiAnalysis: string | null
  tags: string[]
}

/** 落库 tags 组装：review:{cadence} 在最前 + 客户端附加 tag（服务端专用，不再过保留前缀校验） */
export function reviewTagsForCadence(
  cadence: ReviewCadence,
  clientTags: string[],
): string[] {
  return [`review:${cadence}`, ...clientTags]
}

/**
 * 校验复盘创建请求并归一化（纯解析，不落库）。
 * cadence 必填、严格小写、不 trim（"WEEKLY" / " Weekly" → Invalid cadence）。
 */
export function parseReview(
  body: LogReviewBody,
): NormalizedReview | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_REVIEW_KEYS)
  if (unknown) return unknown

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) return happenedResult

  if (typeof body.cadence !== 'string' || body.cadence === '') {
    return { error: MISSING_CADENCE_MESSAGE }
  }
  if (!(REVIEW_CADENCES as readonly string[]).includes(body.cadence)) {
    return { error: INVALID_CADENCE_MESSAGE }
  }

  const rawContent = requireTrimmedText(body.raw_content, 'raw_content')
  if ('error' in rawContent) return rawContent

  const objCtx = requireTrimmedText(body.objective_context, 'objective_context')
  if ('error' in objCtx) return objCtx

  const aiAnalysis = optionalTrimmedNullable(body.ai_analysis, 'ai_analysis')
  if ('error' in aiAnalysis) return aiAnalysis

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

  return {
    happenedAt: happenedResult.value,
    utcOffset: happenedResult.utcOffset,
    cadence: body.cadence as ReviewCadence,
    rawContent: rawContent.value,
    objectiveContext: objCtx.value,
    aiAnalysis: aiAnalysis.value,
    tags: tagList,
  }
}
