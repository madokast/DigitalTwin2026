/**
 * log 录入：校验 + Drizzle 写入；与 Go `faas/internal/logapi` 同构。
 * Telegram 不在此包——由 HTTP route 在成功后 best-effort 调用。
 */
import { logger } from './logger'
import { errorMessage } from './httperror'
import { UoW } from '@/db/uow'
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { Repo } from '@/lib/recordrepo'
import { RecordNotFoundError } from '@/lib/record/errors'
import { parseBodyWeight, type LogBodyWeightBody } from '@/lib/bodyweightdraft'
import {
  optionalTrimmedNullable,
  parseHappenedAt,
  parseNumericValue,
  requireTrimmedText,
} from '@/lib/draft'
import {
  isValidRecordId,
  INVALID_RECORD_ID,
  type NewRecord,
  type Record,
} from '@/lib/record'
import { assertNoReservedTags, firstDuplicateTag, validateTags } from '@/lib/tags'
import {
  auditObjectiveContext,
  todoAuditNotifyText,
  ERR_ALREADY_TARGET,
  ERR_AUDIT_TRANSITION,
  ERR_NOT_A_TODO,
  ERR_TODO_NOT_FOUND,
  isTodoAuditRecordTags,
  parseTodo,
  parseTodoTransition,
  replaceTodoStateInTags,
  TODO_TAG_TRANSITION,
  todoStateFromTags,
  type LogTodoBody,
  type LogTodoTransitionBody,
  type TodoState,
} from '@/lib/tododraft'
import { parseNumberBatch } from '@/lib/numberdraft'
import { parseTransactionBatch, sumMoneyAmounts2, type TransactionType } from '@/lib/transactiondraft'
import {
  parseReview,
  reviewTagsForCadence,
  type LogReviewBody,
} from '@/lib/reviewdraft'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

export const LOG_TEXT_KEYS = [
  'happened_at',
  'raw_content',
  'objective_context',
  'ai_analysis',
  'tags',
] as const

export type TextBody = {
  happened_at?: unknown
  raw_content?: unknown
  objective_context?: unknown
  ai_analysis?: unknown
  tags?: unknown
}

export type LogApiError = { error: string; status: number }

export type CreateRecordOk = { record: Record; status: 201 }
export type CreateRecordResult = CreateRecordOk | LogApiError

export type CreateBatchOk = {
  inserted: number
  type: TransactionType
  sum: string
  records: Record[]
  status: 201
}
export type CreateBatchResult = CreateBatchOk | LogApiError

/** tags optional：省略 / null / [] → []；非数组或元素非 string → 400 */
function optionalTagList(raw: unknown): { value: string[] } | { error: string } {
  if (raw === undefined || raw === null) {
    return { value: [] }
  }
  if (!Array.isArray(raw)) {
    return { error: 'tags must be an array of strings' }
  }
  if (!raw.every((t) => typeof t === 'string')) {
    return { error: 'tags must be an array of strings' }
  }
  const dup = firstDuplicateTag(raw)
  if (dup !== null) {
    return { error: `duplicate tag "${dup}"` }
  }
  return { value: raw }
}

export type CreateNumberBatchOk = {
  inserted: number
  records: Record[]
  status: 201
}
export type CreateNumberBatchResult = CreateNumberBatchOk | LogApiError

/**
 * 与 Go `logapi.CreateNumberBatch` 对齐：
 * 解析委托 `parseNumberBatch`，整单事务写入。
 * 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
 */
export async function createNumberBatch(
  body: unknown,
): Promise<CreateNumberBatchResult> {
  const parsed = parseNumberBatch(
    body as Parameters<typeof parseNumberBatch>[0],
  )
  if ('error' in parsed) {
    return { error: parsed.error, status: 400 }
  }

  try {
    // 批量原子：业务层经 UoW 决定事务性；rows（DB 直接映射）组装零 DB。
    const nrs: NewRecord[] = parsed.entries.map((entry) => ({
      id: uuidv7(),
      happenedAt: { time: parsed.happenedAt, offset: parsed.utcOffset },
      numericValue: entry.numericValue,
      rawContent: null,
      tags: entry.tags,
      objectiveContext: entry.objectiveContext,
      aiAnalysis: entry.aiAnalysis,
    }))
    const out = await new UoW(db).do(async (q) => {
      const res = await Repo.saveAll(q, nrs)
      if (!res.ok) {
        throw res.error
      }
      return res.records
    })
    return {
      inserted: out.length,
      records: out,
      status: 201,
    }
  } catch (err) {
    logger.error({ err }, 'Error creating number records')
    return { error: errorMessage(err), status: 500 }
  }
}

/**
 * 与 Go `logapi.CreateBodyWeight` 对齐：
 * 解析委托 `parseBodyWeight`，落库强制含 `body:weight`。
 */
export async function createBodyWeight(
  body: LogBodyWeightBody,
): Promise<CreateRecordResult> {
  const parsed = parseBodyWeight(body)
  if ('error' in parsed) {
    return { error: parsed.error, status: 400 }
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happenedAt: { time: parsed.happenedAt, offset: parsed.utcOffset },
      numericValue: parsed.numericValue,
      rawContent: null,
      tags: parsed.tags,
      objectiveContext: parsed.objectiveContext,
      aiAnalysis: parsed.aiAnalysis,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    logger.error({ err }, 'Error creating body weight record')
    return { error: errorMessage(err), status: 500 }
  }
}

/**
 * 与 Go `logapi.CreateTodo` 对齐：
 * 解析委托 `parseTodo`，落库强制含 `todo:in_progress`；返回内部 Record（HTTP 层再变形）。
 */
export async function createTodo(
  body: LogTodoBody,
): Promise<CreateRecordResult> {
  const parsed = parseTodo(body)
  if ('error' in parsed) {
    return { error: parsed.error, status: 400 }
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happenedAt: { time: parsed.happenedAt, offset: parsed.utcOffset },
      numericValue: null,
      rawContent: parsed.rawContent,
      tags: parsed.tags,
      objectiveContext: parsed.objectiveContext,
      aiAnalysis: parsed.aiAnalysis,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    logger.error({ err }, 'Error creating to-do record')
    return { error: errorMessage(err), status: 500 }
  }
}

export type TransitionTodoOk = {
  id: string
  from: TodoState
  to: TodoState
  todoAuditNotifyText: string
  status: 200
}
export type TransitionTodoResult = TransitionTodoOk | LogApiError

/**
 * 与 Go `logapi.TransitionTodo` 对齐：同事务 UPDATE 状态 tag + INSERT 审计。
 */
export async function transitionTodo(
  body: LogTodoTransitionBody,
): Promise<TransitionTodoResult> {
  const parsed = parseTodoTransition(body)
  if ('error' in parsed) {
    return { error: parsed.error, status: 400 }
  }
  if (!isValidRecordId(parsed.id)) {
    return { error: INVALID_RECORD_ID, status: 400 }
  }

  try {
    // 预读（非 CAS：只用于判断与组装，事务外，事务持有时间最短）
    const found = await Repo.findById(db, parsed.id)
    if (!found.ok) {
      if (found.error instanceof RecordNotFoundError) {
        return { error: ERR_TODO_NOT_FOUND, status: 404 }
      }
      return { error: errorMessage(found.error), status: 500 }
    }

    const todoRec = found.record!
    const tagList = todoRec.tags

    if (isTodoAuditRecordTags(tagList)) {
      return { error: ERR_AUDIT_TRANSITION, status: 400 }
    }
    const from = todoStateFromTags(tagList)
    if (!from) {
      return { error: ERR_NOT_A_TODO, status: 400 }
    }
    if (from === parsed.target) {
      return { error: ERR_ALREADY_TARGET, status: 400 }
    }

    const content = todoRec.raw_content ?? ''
    const notifyText = todoAuditNotifyText(
      parsed.target,
      parsed.id,
      todoRec.happened_at,
      content,
    )
    const objCtx = auditObjectiveContext(
      parsed.target,
      parsed.id,
      todoRec.happened_at,
    )
    const newTags = replaceTodoStateInTags(tagList, parsed.target)

    // 写路径：UPDATE 状态 tag + INSERT 审计，原子（业务层经 UoW 决定事务性）。
    // D7 对齐 Go（RowsAffected() != 1 → 500）：SELECT 与 UPDATE 之间记录被删的并发竞态
    // —— 影响行数 ≠ 1 时不插审计行、事务回滚，错误文案含实际行数。
    // 审计行 happened_at 与请求一致（parse 产物 Date + offset 直接填 DBRow，零字符串往返）
    await new UoW(db).do(async (q) => {
      const t = await Repo.transition(q, parsed.id, newTags)
      if (!t.ok) {
        throw t.error
      }
      await Repo.save(q, {
        id: uuidv7(),
        happenedAt: { time: parsed.happenedAt, offset: parsed.utcOffset },
        numericValue: null,
        rawContent: content,
        tags: [TODO_TAG_TRANSITION],
        objectiveContext: objCtx,
        aiAnalysis: null,
      })
    })

    return {
      id: parsed.id,
      from,
      to: parsed.target,
      todoAuditNotifyText: notifyText,
      status: 200,
    }
  } catch (err) {
    logger.error({ err }, 'Error transitioning to-do')
    return { error: errorMessage(err), status: 500 }
  }
}

/** 与 Go `logapi.CreateText` 对齐：校验 + INSERT */
export async function createText(body: TextBody): Promise<CreateRecordResult> {
  const unknown = rejectUnknownKeys(body, LOG_TEXT_KEYS)
  if (unknown) {
    return { error: unknown.error, status: 400 }
  }

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) {
    return { error: happenedResult.error, status: 400 }
  }

  const rawContentResult = requireTrimmedText(body.raw_content, 'raw_content')
  if ('error' in rawContentResult) {
    return { error: rawContentResult.error, status: 400 }
  }

  const tagListResult = optionalTagList(body.tags)
  if ('error' in tagListResult) {
    return { error: tagListResult.error, status: 400 }
  }
  const tagsValidation = validateTags(tagListResult.value)
  if (!tagsValidation.valid) {
    return { error: tagsValidation.error!, status: 400 }
  }
  const reserved = assertNoReservedTags(tagListResult.value)
  if (!reserved.valid) {
    return { error: reserved.error!, status: 400 }
  }

  const objCtxResult = requireTrimmedText(body.objective_context, 'objective_context')
  if ('error' in objCtxResult) {
    return { error: objCtxResult.error, status: 400 }
  }

  const aiAnalysis = optionalTrimmedNullable(body.ai_analysis, 'ai_analysis')
  if ('error' in aiAnalysis) {
    return { error: aiAnalysis.error, status: 400 }
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happenedAt: { time: happenedResult.value, offset: happenedResult.utcOffset },
      numericValue: null,
      rawContent: rawContentResult.value,
      tags: tagListResult.value,
      objectiveContext: objCtxResult.value,
      aiAnalysis: aiAnalysis.value,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    logger.error({ err }, 'Error creating text record')
    return { error: errorMessage(err), status: 500 }
  }
}

/**
 * 与 Go `logapi.CreateReview` 对齐：解析委托 `parseReview`，
 * 落库 tags = `[review:{cadence}, ...clientTags]`（自动附加，客户端不得传 `review:*`）。
 */
export async function createReview(
  body: unknown,
): Promise<CreateRecordResult> {
  const parsed = parseReview(body as LogReviewBody)
  if ('error' in parsed) {
    return { error: parsed.error, status: 400 }
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happenedAt: { time: parsed.happenedAt, offset: parsed.utcOffset },
      numericValue: null,
      rawContent: parsed.rawContent,
      tags: reviewTagsForCadence(parsed.cadence, parsed.tags),
      objectiveContext: parsed.objectiveContext,
      aiAnalysis: parsed.aiAnalysis,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    logger.error({ err }, 'Error creating review record')
    return { error: errorMessage(err), status: 500 }
  }
}

/**
 * 与 Go `logapi.CreateTransactionBatch` 对齐：
 * 解析委托 `parseTransactionBatch`，整单事务写入。
 */
export async function createTransactionBatch(
  body: unknown,
): Promise<CreateBatchResult> {
  const parsed = parseTransactionBatch(
    body as Parameters<typeof parseTransactionBatch>[0],
  )
  if ('error' in parsed) {
    return { error: parsed.error, status: 400 }
  }

  try {
    // 批量原子：业务层经 UoW 决定事务性；rows（DB 直接映射）组装零 DB。
    const nrs: NewRecord[] = parsed.entries.map((entry) => ({
      id: uuidv7(),
      happenedAt: { time: parsed.happenedAt, offset: parsed.utcOffset },
      numericValue: entry.amount,
      rawContent: null,
      tags: entry.tags,
      objectiveContext: entry.memo,
      aiAnalysis: null,
    }))
    const out = await new UoW(db).do(async (q) => {
      const res = await Repo.saveAll(q, nrs)
      if (!res.ok) {
        throw res.error
      }
      return res.records
    })
    return {
      inserted: out.length,
      type: parsed.type,
      sum: sumMoneyAmounts2(parsed.entries.map((e) => e.amount)),
      records: out,
      status: 201,
    }
  } catch (err) {
    logger.error({ err }, 'Error creating transaction records')
    return { error: errorMessage(err), status: 500 }
  }
}
