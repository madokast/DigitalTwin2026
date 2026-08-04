/**
 * 待办录入纯解析与对外 JSON 变形（与 faas/internal/tododraft 同构）。
 * 创建：created_at → happened_at，content → raw_content；落库 tags 以 todo:in_progress 开头。
 */
import {
  parseHappenedAt,
  type DraftValidationError,
} from '@/lib/draft'
import {
  isValidTag,
  assertNoReservedTags,
} from '@/lib/tags'
import {
  optionalTrimmedNullable,
  requireTrimmedText,
} from '@/lib/draft'
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
  'ai_analysis',
  'tags',
] as const

export type LogTodoBody = {
  created_at?: unknown
  content?: unknown
  objective_context?: unknown
  ai_analysis?: unknown
  tags?: unknown
}

export type NormalizedTodo = {
  happenedAt: Date
  utcOffset: string
  rawContent: string
  tags: string[]
  objectiveContext: string
  aiAnalysis: string | null
}

/** 待办行 HTTP JSON（别名键；其余字段与 Record snake_case 一致；numeric_value 恒 null → 省略） */
export type TodoRecordJson = {
  id: string
  created_at: string
  content: string
  tags: string[]
  objective_context: string
  ai_analysis: string | null
}

/** 将内部 Record 变形为待办对外形状（去掉 happened_at / raw_content / numeric_value） */
export function toTodoRecordJson(rec: Record): TodoRecordJson {
  return {
    id: rec.id,
    created_at: rec.happened_at,
    content: rec.raw_content ?? '',
    tags: rec.tags,
    objective_context: rec.objective_context,
    ai_analysis: rec.ai_analysis,
  }
}

/**
 * 查询侧略宽判定（§1.3）：tags 至少含一个四态 tag → 按待办行变形。
 * 四态与 `todo:transition` 并存时仍变形（有四态优先）。与 Go 同规则。
 */
export function shouldDeformTodoRecordTags(tagList: string[]): boolean {
  for (const tag of tagList) {
    if (isStateTag(tag)) return true
  }
  return false
}

/** Transition 四类可区分英文错误（双端字节一致） */
export const ERR_TODO_NOT_FOUND = 'to-do not found'
export const ERR_NOT_A_TODO = 'record is not a to-do'
export const ERR_AUDIT_TRANSITION = 'cannot transition a to-do audit record'
export const ERR_ALREADY_TARGET = 'to-do is already in target state'
export const ERR_INVALID_TARGET =
  'target must be one of: in_progress, completed, cancelled, paused'

export const LOG_TODO_TRANSITION_KEYS = [
  'id',
  'target',
  'happened_at',
] as const

export type LogTodoTransitionBody = {
  id?: unknown
  target?: unknown
  happened_at?: unknown
}

export type NormalizedTodoTransition = {
  id: string
  target: TodoState
  happenedAt: Date
  utcOffset: string
}

function isStateTag(tag: string): boolean {
  return (
    tag === TODO_TAG_IN_PROGRESS ||
    tag === TODO_TAG_COMPLETED ||
    tag === TODO_TAG_CANCELLED ||
    tag === TODO_TAG_PAUSED
  )
}

/** `todo:{state}` → TodoState；非状态 tag → null */
export function todoStateFromTag(tag: string): TodoState | null {
  switch (tag) {
    case TODO_TAG_IN_PROGRESS:
      return 'in_progress'
    case TODO_TAG_COMPLETED:
      return 'completed'
    case TODO_TAG_CANCELLED:
      return 'cancelled'
    case TODO_TAG_PAUSED:
      return 'paused'
    default:
      return null
  }
}

export function todoTagForState(state: TodoState): string {
  return `todo:${state}`
}

/**
 * 录入侧严判定：恰好一个四态 tag，且不含 todo:transition。
 */
export function isStrictTodoRecordTags(tagList: string[]): boolean {
  let stateCount = 0
  for (const tag of tagList) {
    if (tag === TODO_TAG_TRANSITION) return false
    if (isStateTag(tag)) {
      stateCount++
    }
  }
  return stateCount === 1
}

/** 审计行：含 todo:transition 且无四态代表 tag */
export function isTodoAuditRecordTags(tagList: string[]): boolean {
  let hasTransition = false
  let hasState = false
  for (const tag of tagList) {
    if (tag === TODO_TAG_TRANSITION) hasTransition = true
    if (isStateTag(tag)) hasState = true
  }
  return hasTransition && !hasState
}

/** 严待办行上的唯一代表状态；否则 null */
export function todoStateFromTags(tagList: string[]): TodoState | null {
  if (!isStrictTodoRecordTags(tagList)) return null
  for (const tag of tagList) {
    const state = todoStateFromTag(tag)
    if (state) return state
  }
  return null
}

/** 仅替换唯一四态 tag；其余 tags 原样保留（调用方须先严判定） */
export function replaceTodoStateInTags(
  tagList: string[],
  target: TodoState,
): string[] {
  const targetTag = todoTagForState(target)
  return tagList.map((tag) => (isStateTag(tag) ? targetTag : tag))
}

/**
 * §3.1 审计行 objective_context 合成句；happenedAt 为流转前待办行
 * `fromDB` 按 utc_offset 格式化后的带区串（不得传 time.Time 原始值）。
 */
export function auditObjectiveContext(
  target: TodoState,
  todoId: string,
  todoHappenedAt: string,
): string {
  return `${verbFor(target)} a to-do ${todoId} created at ${todoHappenedAt}`
}

/**
 * D6 通知正文：审计行 objective_context 句 + `": "` + 待办正文逐字拷贝。
 * 与审计行 `objective_context` / `raw_content` 两字段可还原，非字节级一致。
 */
export function todoAuditNotifyText(
  target: TodoState,
  todoId: string,
  todoHappenedAt: string,
  todoRawContent: string,
): string {
  return `${verbFor(target)} a to-do ${todoId} created at ${todoHappenedAt}: ${todoRawContent}`
}

function verbFor(target: TodoState): string {
  switch (target) {
    case 'completed':
      return 'Complete'
    case 'cancelled':
      return 'Cancel'
    case 'paused':
      return 'Pause'
    default:
      return 'Resume'
  }
}

/**
 * 校验 transition 请求体（未知键 / 必填 / target 枚举 / happened_at）。
 * id 格式由 logapi 用 isValidRecordId 再判。
 */
export function parseTodoTransition(
  body: LogTodoTransitionBody,
): NormalizedTodoTransition | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_TODO_TRANSITION_KEYS)
  if (unknown) {
    return { error: unknown.error }
  }

  if (!body.id || typeof body.id !== 'string') {
    return { error: 'Missing required field: id' }
  }

  if (body.target === undefined || body.target === null || body.target === '') {
    return { error: 'Missing required field: target' }
  }
  if (typeof body.target !== 'string') {
    return { error: ERR_INVALID_TARGET }
  }
  if (!(TODO_STATES as readonly string[]).includes(body.target)) {
    return { error: ERR_INVALID_TARGET }
  }

  const happened = parseHappenedAt(body.happened_at)
  if ('error' in happened) {
    return { error: happened.error }
  }

  return {
    id: body.id,
    target: body.target as TodoState,
    happenedAt: happened.value,
    utcOffset: happened.utcOffset,
  }
}

/** created_at 校验：语义同 parseHappenedAt，错误文案用 created_at */
function parseCreatedAt(
  raw: unknown,
): { ok: true; value: Date; utcOffset: string } | DraftValidationError {
  if (typeof raw !== 'string' || !raw) {
    return { error: 'Missing required field: created_at' }
  }
  const result = parseHappenedAt(raw)
  if ('error' in result) {
    return { error: result.error.replaceAll('happened_at', 'created_at') }
  }
  return result
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

  const contentResult = requireTrimmedText(body.content, 'content')
  if ('error' in contentResult) {
    return { error: contentResult.error }
  }
  const content = contentResult.value

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
    happenedAt: createdResult.value,
    utcOffset: createdResult.utcOffset,
    rawContent: content,
    tags: [TODO_TAG_IN_PROGRESS, ...clientTags.value],
    objectiveContext: objCtxResult.value,
    aiAnalysis: aiAnalysis.value,
  }
}
