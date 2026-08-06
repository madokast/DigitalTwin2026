/**
 * log 录入：校验 + Drizzle 写入；与 Go `faas/internal/logapi` 同构。
 * Telegram 不在此包——由 HTTP route 在成功后 best-effort 调用。
 */
import { logger } from './logger'
import { UoW } from '@/db/uow'
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { Repo } from '@/lib/recordrepo'
import { MyError, newInternal, newNotFound, newValidation } from '@/lib/myerr'
import { parseBodyWeight, type LogBodyWeightBody } from '@/lib/bodyweightdraft'
import {
  optionalTrimmedNullable,
  parseHappenedAt,
  requireTrimmedText,
} from '@/lib/draft'
import {
  isValidRecordId,
  INVALID_RECORD_ID,
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

export type CreateRecordOk = { record: Record; status: 201 }
export type CreateRecordResult = CreateRecordOk
export type CreateBatchOk = {
  inserted: number
  type: TransactionType
  sum: string
  records: Record[]
  status: 201
}
export type CreateBatchResult = CreateBatchOk

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
export type CreateNumberBatchResult = CreateNumberBatchOk

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
    throw newValidation(parsed.error)
  }

  try {
    // 领域 Record 组装（happened_at = 已校验请求串；Repository 内解析落库）。
    const nrs: Record[] = parsed.entries.map((entry) => ({
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      numeric_value: entry.numericValue,
      raw_content: null,
      tags: entry.tags,
      objective_context: entry.objectiveContext,
      ai_analysis: entry.aiAnalysis,
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
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error creating number records')
    throw newInternal(err)
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
    throw newValidation(parsed.error)
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      numeric_value: parsed.numericValue,
      raw_content: null,
      tags: parsed.tags,
      objective_context: parsed.objectiveContext,
      ai_analysis: parsed.aiAnalysis,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error creating body weight record')
    throw newInternal(err)
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
    throw newValidation(parsed.error)
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      raw_content: parsed.rawContent,
      tags: parsed.tags,
      objective_context: parsed.objectiveContext,
      ai_analysis: parsed.aiAnalysis,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error creating to-do record')
    throw newInternal(err)
  }
}

export type TransitionTodoOk = {
  id: string
  from: TodoState
  to: TodoState
  todoAuditNotifyText: string
  status: 200
}
export type TransitionTodoResult = TransitionTodoOk

/**
 * 与 Go `logapi.TransitionTodo` 对齐：同事务 UPDATE 状态 tag + INSERT 审计。
 */
export async function transitionTodo(
  body: LogTodoTransitionBody,
): Promise<TransitionTodoResult> {
  const parsed = parseTodoTransition(body)
  if ('error' in parsed) {
    throw newValidation(parsed.error)
  }
  if (!isValidRecordId(parsed.id)) {
    throw newValidation(INVALID_RECORD_ID)
  }

  try {
    // 预读（非 CAS：只用于判断与组装，事务外，事务持有时间最短）
    const found = await Repo.findById(db, parsed.id)
    if (!found.ok) {
      if (found.error?.status === 404) {
        throw newNotFound(ERR_TODO_NOT_FOUND)
      }
      throw found.error ?? newInternal(new Error('findById failed'))
    }

    const todoRec = found.record!
    const tagList = todoRec.tags

    if (isTodoAuditRecordTags(tagList)) {
      throw newValidation(ERR_AUDIT_TRANSITION)
    }
    const from = todoStateFromTags(tagList)
    if (!from) {
      throw newValidation(ERR_NOT_A_TODO)
    }
    if (from === parsed.target) {
      throw newValidation(ERR_ALREADY_TARGET)
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
    // 审计行 happened_at 与请求一致（已校验请求串；Repository 内解析落库）
    await new UoW(db).do(async (q) => {
      const t = await Repo.transition(q, parsed.id, newTags)
      if (!t.ok) {
        throw t.error
      }
      await Repo.save(q, {
        id: uuidv7(),
        happened_at: parsed.happenedAtRaw,
        raw_content: content,
        tags: [TODO_TAG_TRANSITION],
        objective_context: objCtx,
        ai_analysis: null,
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
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error transitioning to-do')
    throw newInternal(err)
  }
}

/** 与 Go `logapi.CreateText` 对齐：校验 + INSERT */
export async function createText(body: TextBody): Promise<CreateRecordResult> {
  const unknown = rejectUnknownKeys(body, LOG_TEXT_KEYS)
  if (unknown) {
    throw newValidation(unknown.error)
  }

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) {
    throw newValidation(happenedResult.error)
  }
  const happenedAtRaw = body.happened_at as string

  const rawContentResult = requireTrimmedText(body.raw_content, 'raw_content')
  if ('error' in rawContentResult) {
    throw newValidation(rawContentResult.error)
  }

  const tagListResult = optionalTagList(body.tags)
  if ('error' in tagListResult) {
    throw newValidation(tagListResult.error)
  }
  const tagsValidation = validateTags(tagListResult.value)
  if (!tagsValidation.valid) {
    throw newValidation(tagsValidation.error!)
  }
  const reserved = assertNoReservedTags(tagListResult.value)
  if (!reserved.valid) {
    throw newValidation(reserved.error!)
  }

  const objCtxResult = requireTrimmedText(body.objective_context, 'objective_context')
  if ('error' in objCtxResult) {
    throw newValidation(objCtxResult.error)
  }

  const aiAnalysis = optionalTrimmedNullable(body.ai_analysis, 'ai_analysis')
  if ('error' in aiAnalysis) {
    throw newValidation(aiAnalysis.error)
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happened_at: happenedAtRaw,
      raw_content: rawContentResult.value,
      tags: tagListResult.value,
      objective_context: objCtxResult.value,
      ai_analysis: aiAnalysis.value,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error creating text record')
    throw newInternal(err)
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
    throw newValidation(parsed.error)
  }

  try {
    const res = await Repo.save(db, {
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      raw_content: parsed.rawContent,
      tags: reviewTagsForCadence(parsed.cadence, parsed.tags),
      objective_context: parsed.objectiveContext,
      ai_analysis: parsed.aiAnalysis,
    })
    if (!res.ok) throw res.error
    return { record: res.record!, status: 201 }
  } catch (err) {
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error creating review record')
    throw newInternal(err)
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
    throw newValidation(parsed.error)
  }

  try {
    // 领域 Record 组装（happened_at = 已校验请求串；Repository 内解析落库）。
    const nrs: Record[] = parsed.entries.map((entry) => ({
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      numeric_value: entry.amount,
      raw_content: null,
      tags: entry.tags,
      objective_context: entry.memo,
      ai_analysis: null,
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
    if (err instanceof MyError) throw err
    logger.error({ err }, 'Error creating transaction records')
    throw newInternal(err)
  }
}
