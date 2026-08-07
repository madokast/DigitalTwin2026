/**
 * log 录入：校验 + Drizzle 写入；与 Go `faas/internal/logapi` 同构。
 * Telegram 不在此包——由 HTTP route 在成功后 best-effort 调用。
 */
import { UoW } from '@/db/uow'

type Db = typeof db
const dbDefault = db
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { Repo } from '@/lib/recordrepo'
import { MyError, newNotFound, newValidation } from '@/lib/myerr'
import type { NormalizedBodyWeight } from '@/lib/bodyweightdraft'
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
  replaceTodoStateInTags,
  TODO_TAG_TRANSITION,
  todoStateFromTags,
  type NormalizedTodo,
  type NormalizedTodoTransition,
  type TodoState,
} from '@/lib/tododraft'
import type { NormalizedNumberBatch } from '@/lib/numberdraft'
import { sumMoneyAmounts, type NormalizedTransactionBatch, type TransactionType } from '@/lib/transactiondraft'
import { reviewTagsForCadence, type NormalizedReview } from '@/lib/reviewdraft'
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

export type CreateBatchOk = {
  inserted: number
  type: TransactionType
  sum: string
  records: Record[]
}

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
}

/**
 * 与 Go `logapi.CreateNumberBatch` 对齐：
 * 解析委托 `parseNumberBatch`，整单事务写入。
 * 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
 */


/**
 * 与 Go `logapi.CreateBodyWeight` 对齐：
 * 解析委托 `parseBodyWeight`，落库强制含 `body:weight`。
 */


/**
 * 与 Go `logapi.CreateTodo` 对齐：
 * 解析委托 `parseTodo`，落库强制含 `todo:in_progress`；返回内部 Record（HTTP 层再变形）。
 */


export type TransitionTodoOk = {
  id: string
  from: TodoState
  to: TodoState
  todoAuditNotifyText: string
}

/**
 * 与 Go `logapi.TransitionTodo` 对齐：同事务 UPDATE 状态 tag + INSERT 审计。
 */


/** 与 Go `logapi.ParseTextBody` 对齐（route 层调用）：reject unknown keys，纯解析不校验语义。 */
/**
 * 日志业务（§10b 步骤 4：class + 构造注入 db/uow；模块级单例）。
 */
export class LogService {
  constructor(
    private readonly db: Db = dbDefault,
    private readonly uow: UoW = new UoW(dbDefault),
  ) {}

    async createNumberBatch(
    parsed: NormalizedNumberBatch,
  ): Promise<CreateNumberBatchOk> {
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
    const out = await this.uow.do(async (q) => {
      return Repo.saveAll(q, nrs)
    })
    return {
      inserted: out.length,
      records: out,
    }
  }

    async createBodyWeight(
    parsed: NormalizedBodyWeight,
  ): Promise<Record> {
    return Repo.save(db, {
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      numeric_value: parsed.numericValue,
      raw_content: null,
      tags: parsed.tags,
      objective_context: parsed.objectiveContext,
      ai_analysis: parsed.aiAnalysis,
    })
  }

    async createTodo(
    parsed: NormalizedTodo,
  ): Promise<Record> {
    return Repo.save(db, {
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      raw_content: parsed.rawContent,
      tags: parsed.tags,
      objective_context: parsed.objectiveContext,
      ai_analysis: parsed.aiAnalysis,
    })
  }

    async transitionTodo(
    parsed: NormalizedTodoTransition,
  ): Promise<TransitionTodoOk> {
    if (!isValidRecordId(parsed.id)) {
      throw newValidation(INVALID_RECORD_ID)
    }

    // 预读（非 CAS：只用于判断与组装，事务外，事务持有时间最短）
    let todoRec: Record
    try {
        todoRec = await Repo.findById(db, parsed.id)
      } catch (err) {
        // 404 文案映射为待办专属（契约）；其余（驱动错误）透传 myerr 500
        if (err instanceof MyError && err.isNotFound()) {
          throw newNotFound(ERR_TODO_NOT_FOUND)
        }
        throw err
      }
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
      await this.uow.do(async (q) => {
        await Repo.transition(q, parsed.id, newTags)
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
      }
  }

    async createText(body: TextBody): Promise<Record> {
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

    return Repo.save(db, {
      id: uuidv7(),
      happened_at: happenedAtRaw,
      raw_content: rawContentResult.value,
      tags: tagListResult.value,
      objective_context: objCtxResult.value,
      ai_analysis: aiAnalysis.value,
    })
  }

    async createReview(
    parsed: NormalizedReview,
  ): Promise<Record> {
    return Repo.save(db, {
      id: uuidv7(),
      happened_at: parsed.happenedAtRaw,
      raw_content: parsed.rawContent,
      tags: reviewTagsForCadence(parsed.cadence, parsed.tags),
      objective_context: parsed.objectiveContext,
      ai_analysis: parsed.aiAnalysis,
    })
  }

    async createTransactionBatch(
    parsed: NormalizedTransactionBatch,
  ): Promise<CreateBatchOk> {
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
    const out = await this.uow.do(async (q) => {
      return Repo.saveAll(q, nrs)
    })
    return {
      inserted: out.length,
      type: parsed.type,
      sum: sumMoneyAmounts(parsed.entries.map((e) => e.amount)),
      records: out,
    }
  }
}

/** 模块级单例（route 装配；vi.mock 兼容）。 */
export const logService = new LogService()

export function parseTextBody(
  raw: unknown,
): TextBody | { error: string } {
  const unknown = rejectUnknownKeys(raw, LOG_TEXT_KEYS)
  if (unknown) {
    return { error: unknown.error }
  }
  return raw as TextBody
}

/** 与 Go `logapi.CreateText` 对齐：校验 + INSERT */


/**
 * 与 Go `logapi.CreateReview` 对齐：解析委托 `parseReview`，
 * 落库 tags = `[review:{cadence}, ...clientTags]`（自动附加，客户端不得传 `review:*`）。
 */


/**
 * 与 Go `logapi.CreateTransactionBatch` 对齐：
 * 解析委托 `parseTransactionBatch`，整单事务写入。
 */

