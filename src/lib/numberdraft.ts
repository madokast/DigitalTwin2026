/**
 * 数值批量录入纯解析（与 faas/internal/numberdraft 同构）。
 * 对齐交易 `transactiondraft` 的批量模式：顶层共享 happened_at + entries 数组。
 * 每条 entry：numeric_value / memo 必填，tags / ai_analysis 可选。
 * 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
 */
import {
  optionalTrimmedNullable,
  parseHappenedAt,
  parseNumericValue,
  requireTrimmedText,
  type DraftValidationError,
} from '@/lib/draft'
import {
  assertNoReservedTags,
  firstDuplicateTag,
  validateTags,
} from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

export const LOG_NUMBERS_KEYS = ['happened_at', 'entries'] as const

export const NUMBER_ENTRY_KEYS = [
  'numeric_value',
  'memo',
  'tags',
  'ai_analysis',
] as const

export const MAX_NUMBER_ENTRIES = 100

export type NumberEntryInput = {
  numeric_value?: unknown
  memo?: unknown
  tags?: unknown
  ai_analysis?: unknown
}

export type LogNumbersBody = {
  happened_at?: unknown
  entries?: unknown
}

export type NormalizedNumberEntry = {
  numericValue: string
  objectiveContext: string
  tags: string[]
  aiAnalysis: string | null
}

export type NormalizedNumberBatch = {
  happenedAt: Date
  utcOffset: string
  entries: NormalizedNumberEntry[]
}

function parseEntry(
  raw: unknown,
  index: number,
): NormalizedNumberEntry | DraftValidationError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `entries[${index}] must be an object` }
  }
  const unknown = rejectUnknownKeys(raw, NUMBER_ENTRY_KEYS)
  if (unknown) {
    return { error: `entries[${index}]: ${unknown.error}` }
  }
  const entry = raw as NumberEntryInput

  // numeric_value 必填且非 null（批量数值每条必须有值）
  if (entry.numeric_value === undefined || entry.numeric_value === null) {
    return { error: `entries[${index}]: Missing required field: numeric_value` }
  }
  const numResult = parseNumericValue(entry.numeric_value)
  if ('error' in numResult) {
    return { error: `entries[${index}]: ${numResult.error}` }
  }
  if (numResult.value === null) {
    return { error: `entries[${index}]: Missing required field: numeric_value` }
  }

  // memo 必填 → objective_context（DB NOT NULL）
  const memoResult = requireTrimmedText(entry.memo, 'memo')
  if ('error' in memoResult) {
    return { error: `entries[${index}]: ${memoResult.error}` }
  }

  // tags 可选（省略 → []），传了则校验格式 + 拒保留前缀
  let tags: string[] = []
  if (entry.tags !== undefined && entry.tags !== null) {
    if (!Array.isArray(entry.tags)) {
      return { error: `entries[${index}]: tags must be an array of strings` }
    }
    const tagList = entry.tags
    if (!tagList.every((t) => typeof t === 'string')) {
      return { error: `entries[${index}]: tags must be an array of strings` }
    }
    const valid = validateTags(tagList)
    if (!valid.valid) {
      return { error: `entries[${index}]: ${valid.error}` }
    }
    const reserved = assertNoReservedTags(tagList)
    if (!reserved.valid) {
      return { error: `entries[${index}]: ${reserved.error}` }
    }
    const dup = firstDuplicateTag(tagList)
    if (dup !== null) {
      return { error: `entries[${index}]: Duplicate tag "${dup}"` }
    }
    tags = tagList
  }

  // ai_analysis 可选：省略/null → null；空白 → 400
  const aiResult = optionalTrimmedNullable(entry.ai_analysis, 'ai_analysis')
  if ('error' in aiResult) {
    return { error: `entries[${index}]: ${aiResult.error}` }
  }

  return {
    numericValue: numResult.value,
    objectiveContext: memoResult.value,
    tags,
    aiAnalysis: aiResult.value,
  }
}

/**
 * 解析 POST /api/log/numbers body。
 * 顶层 happened_at 必填整单共享；entries 长度 1..MAX；
 * 非数组 / 空 / 超上限 → 顶层错误（无 index）；逐条错误带 `entries[i]:` 前缀。
 */
export function parseNumberBatch(
  body: LogNumbersBody,
): NormalizedNumberBatch | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_NUMBERS_KEYS)
  if (unknown) return unknown

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) return happenedResult

  if (!Array.isArray(body.entries)) {
    return { error: 'Missing required field: entries (non-empty array)' }
  }
  if (body.entries.length === 0) {
    return { error: 'entries must be a non-empty array' }
  }
  if (body.entries.length > MAX_NUMBER_ENTRIES) {
    return {
      error: `entries must contain at most ${MAX_NUMBER_ENTRIES} items`,
    }
  }

  const entries: NormalizedNumberEntry[] = []
  for (let i = 0; i < body.entries.length; i++) {
    const parsed = parseEntry(body.entries[i], i)
    if ('error' in parsed) return parsed
    entries.push(parsed)
  }

  return {
    happenedAt: happenedResult.value,
    utcOffset: happenedResult.utcOffset,
    entries,
  }
}
