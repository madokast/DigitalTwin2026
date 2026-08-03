/**
 * 待办录入纯解析与对外 JSON 变形（与 faas/internal/tododraft 同构）。
 * 创建：created_at → happened_at，content → value_text；落库 tags 以 todo:in_progress 开头。
 */
import {
  parseHappenedAt,
  type DraftValidationError,
} from '@/lib/draft'
import {
  isValidTag,
  assertNoReservedTags,
} from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'
import type { Record } from '@/lib/record'

/** TodoState 字面量（非完整 tag） */
export const TODO_STATES = [
  'in_progress',
  'completed',
  'cancelled',
  'paused',
] as const

export type TodoState = (typeof TODO_STATES)[number]

export const TODO_TAG_IN_PROGRESS = 'todo:in_progress'
export const TODO_TAG_COMPLETED = 'todo:completed'
export const TODO_TAG_CANCELLED = 'todo:cancelled'
export const TODO_TAG_PAUSED = 'todo:paused'
export const TODO_TAG_TRANSITION = 'todo:transition'

/** 系统闭集：四个状态 tag + 审计 tag */
export const TODO_SYSTEM_TAGS = [
  TODO_TAG_IN_PROGRESS,
  TODO_TAG_COMPLETED,
  TODO_TAG_CANCELLED,
  TODO_TAG_PAUSED,
  TODO_TAG_TRANSITION,
] as const

export const LOG_TODO_KEYS = [
  'created_at',
  'content',
  'objective_context',
  'subjective_interpretation',
  'tags',
  'suppress_notification',
] as const

export type LogTodoBody = {
  created_at?: unknown
  content?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
  tags?: unknown
  suppress_notification?: unknown
}

export type NormalizedTodo = {
  happenedAt: Date
  valueText: string
  tags: string[]
  objectiveContext: string
  subjectiveInterpretation: string | null
}

/** 待办行 HTTP JSON（别名键；其余字段与 Record camelCase 一致） */
export type TodoRecordJson = {
  id: string
  created_at: string
  valueNumber: null
  content: string
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

/** 将内部 Record 变形为待办对外形状（去掉 happenedAt / valueText） */
export function toTodoRecordJson(rec: Record): TodoRecordJson {
  return {
    id: rec.id,
    created_at: rec.happenedAt,
    valueNumber: null,
    content: rec.valueText ?? '',
    tags: rec.tags,
    objectiveContext: rec.objectiveContext,
    subjectiveInterpretation: rec.subjectiveInterpretation,
  }
}

/**
 * 录入侧严判定：恰好一个四态 tag，且不含 todo:transition。
 * Phase 2 创建路径不依赖；供后续 transition / 测试复用。
 */
export function isStrictTodoRecordTags(tagList: string[]): boolean {
  let stateCount = 0
  for (const tag of tagList) {
    if (tag === TODO_TAG_TRANSITION) return false
    if (
      tag === TODO_TAG_IN_PROGRESS ||
      tag === TODO_TAG_COMPLETED ||
      tag === TODO_TAG_CANCELLED ||
      tag === TODO_TAG_PAUSED
    ) {
      stateCount++
    }
  }
  return stateCount === 1
}

/** created_at 校验：语义同 parseHappenedAt，错误文案用 created_at */
function parseCreatedAt(
  raw: unknown,
): { ok: true; value: Date } | DraftValidationError {
  if (typeof raw !== 'string' || !raw) {
    return { error: 'Missing required field: created_at' }
  }
  const result = parseHappenedAt(raw)
  if ('error' in result) {
    return { error: result.error.replaceAll('happened_at', 'created_at') }
  }
  return result
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
 * 校验整单待办创建请求；落库 tags = [todo:in_progress, ...clientTags]。
 */
export function parseTodo(
  body: LogTodoBody,
): NormalizedTodo | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_TODO_KEYS)
  if (unknown) {
    return { error: unknown.error }
  }

  const createdResult = parseCreatedAt(body.created_at)
  if ('error' in createdResult) {
    return { error: createdResult.error }
  }

  if (!body.content || typeof body.content !== 'string') {
    return { error: 'Missing required field: content' }
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
    happenedAt: createdResult.value,
    valueText: body.content,
    tags: [TODO_TAG_IN_PROGRESS, ...clientTags.value],
    objectiveContext: body.objective_context,
    subjectiveInterpretation: subjective.value,
  }
}
