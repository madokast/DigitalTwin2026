/**
 * log 录入：校验 + Drizzle 写入；与 Go `faas/internal/logapi` 同构。
 * Telegram 不在此包——由 HTTP route 在成功后 best-effort 调用。
 */
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { records } from '@/db/schema'
import { parseBodyWeight, type LogBodyWeightBody } from '@/lib/bodyweightdraft'
import {
  optionalTrimmedNullable,
  parseHappenedAt,
  parseNumericValue,
  requireTrimmedText,
} from '@/lib/draft'
import {
  fromDB,
  isValidRecordId,
  INVALID_RECORD_ID,
  tagsJSON,
  type Record,
} from '@/lib/record'
import { assertNoReservedTags, validateTags } from '@/lib/tags'
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
import { parseTransactionBatch, sumMoneyAmounts2, type TransactionType } from '@/lib/transactiondraft'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

export const LOG_NUMBER_KEYS = [
  'happened_at',
  'numeric_value',
  'raw_content',
  'tags',
  'objective_context',
  'subjective_interpretation',
] as const

export const LOG_TEXT_KEYS = [
  'happened_at',
  'raw_content',
  'tags',
  'objective_context',
  'subjective_interpretation',
] as const

export type NumberBody = {
  happened_at?: unknown
  numeric_value?: unknown
  raw_content?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
}

export type TextBody = {
  happened_at?: unknown
  raw_content?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
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

type InsertValues = {
  id: string
  happenedAt: Date
  utcOffset: string
  numericValue: string | null
  rawContent: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

type InsertExecutor = {
  insert: typeof db.insert
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
  return { value: raw }
}

async function insertReturning(
  executor: InsertExecutor,
  values: InsertValues,
): Promise<Record> {
  const result = await executor.insert(records).values(values).returning()
  return fromDB(result[0])
}

/** 与 Go `logapi.CreateNumber` 对齐：校验 + INSERT */
export async function createNumber(
  body: NumberBody,
): Promise<CreateRecordResult> {
  const unknown = rejectUnknownKeys(body, LOG_NUMBER_KEYS)
  if (unknown) {
    return { error: unknown.error, status: 400 }
  }

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) {
    return { error: happenedResult.error, status: 400 }
  }

  if (body.numeric_value === undefined || body.numeric_value === null) {
    return { error: 'Missing required field: numeric_value', status: 400 }
  }
  const numberResult = parseNumericValue(body.numeric_value)
  if ('error' in numberResult) {
    return { error: numberResult.error, status: 400 }
  }
  if (numberResult.value === null) {
    return { error: 'Missing required field: numeric_value', status: 400 }
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

  const subjective = optionalTrimmedNullable(body.subjective_interpretation, 'subjective_interpretation')
  if ('error' in subjective) {
    return { error: subjective.error, status: 400 }
  }

  try {
    const record = await insertReturning(db, {
      id: uuidv7(),
      happenedAt: happenedResult.value,
      utcOffset: happenedResult.utcOffset,
      numericValue: numberResult.value,
      rawContent: rawContentResult.value,
      tags: tagsJSON(tagListResult.value),
      objectiveContext: objCtxResult.value,
      subjectiveInterpretation: subjective.value,
    })
    return { record, status: 201 }
  } catch (err) {
    console.error('Error creating number record:', err)
    return { error: 'Internal server error', status: 500 }
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
    const record = await insertReturning(db, {
      id: uuidv7(),
      happenedAt: parsed.happenedAt,
      utcOffset: parsed.utcOffset,
      numericValue: parsed.numericValue,
      rawContent: null,
      tags: tagsJSON(parsed.tags),
      objectiveContext: parsed.objectiveContext,
      subjectiveInterpretation: parsed.subjectiveInterpretation,
    })
    return { record, status: 201 }
  } catch (err) {
    console.error('Error creating body weight record:', err)
    return { error: 'Internal server error', status: 500 }
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
    const record = await insertReturning(db, {
      id: uuidv7(),
      happenedAt: parsed.happenedAt,
      utcOffset: parsed.utcOffset,
      numericValue: null,
      rawContent: parsed.rawContent,
      tags: tagsJSON(parsed.tags),
      objectiveContext: parsed.objectiveContext,
      subjectiveInterpretation: parsed.subjectiveInterpretation,
    })
    return { record, status: 201 }
  } catch (err) {
    console.error('Error creating to-do record:', err)
    return { error: 'Internal server error', status: 500 }
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
    const existing = await db
      .select()
      .from(records)
      .where(eq(records.id, parsed.id))
      .limit(1)
    if (existing.length === 0) {
      return { error: ERR_TODO_NOT_FOUND, status: 404 }
    }

    const todoRec = fromDB(existing[0])
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

    // D7 对齐 Go（todo.go RowsAffected() != 1 → 500）：SELECT 与 UPDATE 之间记录被删的
    // 并发竞态 —— 影响行数 ≠ 1 时不插审计行、事务回滚，错误文案含实际行数。
    let raceError: string | null = null
    await db.transaction(async (tx) => {
      const res = (await tx
        .update(records)
        .set({ tags: tagsJSON(newTags) })
        .where(eq(records.id, parsed.id))) as { count: number }
      if (res.count !== 1) {
        raceError = `todo update affected ${res.count} rows`
        return
      }
      await tx.insert(records).values({
        id: uuidv7(),
        happenedAt: parsed.happenedAt,
        utcOffset: parsed.utcOffset,
        numericValue: null,
        rawContent: content,
        tags: tagsJSON([TODO_TAG_TRANSITION]),
        objectiveContext: objCtx,
        subjectiveInterpretation: null,
      })
    })
    if (raceError) {
      return { error: raceError, status: 500 }
    }

    return {
      id: parsed.id,
      from,
      to: parsed.target,
      todoAuditNotifyText: notifyText,
      status: 200,
    }
  } catch (err) {
    console.error('Error transitioning to-do:', err)
    return { error: 'Internal server error', status: 500 }
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

  const subjective = optionalTrimmedNullable(body.subjective_interpretation, 'subjective_interpretation')
  if ('error' in subjective) {
    return { error: subjective.error, status: 400 }
  }

  try {
    const record = await insertReturning(db, {
      id: uuidv7(),
      happenedAt: happenedResult.value,
      utcOffset: happenedResult.utcOffset,
      numericValue: null,
      rawContent: rawContentResult.value,
      tags: tagsJSON(tagListResult.value),
      objectiveContext: objCtxResult.value,
      subjectiveInterpretation: subjective.value,
    })
    return { record, status: 201 }
  } catch (err) {
    console.error('Error creating text record:', err)
    return { error: 'Internal server error', status: 500 }
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
    const out = await db.transaction(async (tx) => {
      const rows: Record[] = []
      for (const entry of parsed.entries) {
        const result = await tx
          .insert(records)
          .values({
            id: uuidv7(),
            happenedAt: parsed.happenedAt,
            utcOffset: parsed.utcOffset,
            numericValue: entry.amount,
            rawContent: null,
            tags: tagsJSON(entry.tags),
            objectiveContext: entry.memo,
            subjectiveInterpretation: null,
          })
          .returning()
        rows.push(fromDB(result[0]))
      }
      return rows
    })
    return {
      inserted: out.length,
      type: parsed.type,
      sum: sumMoneyAmounts2(parsed.entries.map((e) => e.amount)),
      records: out,
      status: 201,
    }
  } catch (err) {
    console.error('Error creating transaction records:', err)
    return { error: 'Internal server error', status: 500 }
  }
}
