/**
 * log 录入：校验 + Drizzle 写入；与 Go `faas/internal/logapi` 同构。
 * Telegram 不在此包——由 HTTP route 在成功后 best-effort 调用。
 */
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { records } from '@/db/schema'
import { parseBodyWeight, type LogBodyWeightBody } from '@/lib/bodyweightdraft'
import { parseHappenedAt, parseValueNumber } from '@/lib/draft'
import { fromDB, tagsJSON, type Record } from '@/lib/record'
import { assertNoReservedTags, validateTags } from '@/lib/tags'
import { parseTodo, type LogTodoBody } from '@/lib/tododraft'
import { parseTransactionBatch } from '@/lib/transactiondraft'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

export const LOG_NUMBER_KEYS = [
  'happened_at',
  'value_number',
  'tags',
  'objective_context',
  'subjective_interpretation',
  'suppress_notification',
] as const

export const LOG_TEXT_KEYS = [
  'happened_at',
  'value_text',
  'tags',
  'objective_context',
  'subjective_interpretation',
  'suppress_notification',
] as const

export type NumberBody = {
  happened_at?: unknown
  value_number?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
  suppress_notification?: unknown
}

export type TextBody = {
  happened_at?: unknown
  value_text?: unknown
  tags?: unknown
  objective_context?: unknown
  subjective_interpretation?: unknown
  suppress_notification?: unknown
}

export type LogApiError = { error: string; status: number }

export type CreateRecordOk = { record: Record; status: 201 }
export type CreateRecordResult = CreateRecordOk | LogApiError

export type CreateBatchOk = {
  inserted: number
  records: Record[]
  status: 201
}
export type CreateBatchResult = CreateBatchOk | LogApiError

type InsertValues = {
  id: string
  happenedAt: Date
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

type InsertExecutor = {
  insert: typeof db.insert
}

/** 与 draft / PATCH 对齐：非 string → 400；空串 / null / omit → null */
function optionalSubjective(
  raw: unknown,
): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { value: null }
  }
  if (typeof raw !== 'string') {
    return { error: 'Invalid subjective_interpretation' }
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

  if (body.value_number === undefined || body.value_number === null) {
    return { error: 'Missing required field: value_number', status: 400 }
  }
  const numberResult = parseValueNumber(body.value_number)
  if ('error' in numberResult) {
    return { error: numberResult.error, status: 400 }
  }
  if (numberResult.value === null) {
    return { error: 'Missing required field: value_number', status: 400 }
  }

  if (!Array.isArray(body.tags) || body.tags.length === 0) {
    return {
      error: 'Missing required field: tags (non-empty array)',
      status: 400,
    }
  }
  if (!body.tags.every((t) => typeof t === 'string')) {
    return { error: 'tags must be an array of strings', status: 400 }
  }
  const tagsValidation = validateTags(body.tags)
  if (!tagsValidation.valid) {
    return { error: tagsValidation.error!, status: 400 }
  }
  const reserved = assertNoReservedTags(body.tags)
  if (!reserved.valid) {
    return { error: reserved.error!, status: 400 }
  }

  if (!body.objective_context || typeof body.objective_context !== 'string') {
    return { error: 'Missing required field: objective_context', status: 400 }
  }

  const subjective = optionalSubjective(body.subjective_interpretation)
  if ('error' in subjective) {
    return { error: subjective.error, status: 400 }
  }

  try {
    const record = await insertReturning(db, {
      id: uuidv7(),
      happenedAt: happenedResult.value,
      valueNumber: numberResult.value,
      valueText: null,
      tags: tagsJSON(body.tags),
      objectiveContext: body.objective_context,
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
      valueNumber: parsed.valueNumber,
      valueText: null,
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
      valueNumber: null,
      valueText: parsed.valueText,
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

  if (!body.value_text || typeof body.value_text !== 'string') {
    return { error: 'Missing required field: value_text', status: 400 }
  }

  if (!Array.isArray(body.tags) || body.tags.length === 0) {
    return {
      error: 'Missing required field: tags (non-empty array)',
      status: 400,
    }
  }
  if (!body.tags.every((t) => typeof t === 'string')) {
    return { error: 'tags must be an array of strings', status: 400 }
  }
  const tagsValidation = validateTags(body.tags)
  if (!tagsValidation.valid) {
    return { error: tagsValidation.error!, status: 400 }
  }
  const reserved = assertNoReservedTags(body.tags)
  if (!reserved.valid) {
    return { error: reserved.error!, status: 400 }
  }

  if (!body.objective_context || typeof body.objective_context !== 'string') {
    return { error: 'Missing required field: objective_context', status: 400 }
  }

  const subjective = optionalSubjective(body.subjective_interpretation)
  if ('error' in subjective) {
    return { error: subjective.error, status: 400 }
  }

  try {
    const record = await insertReturning(db, {
      id: uuidv7(),
      happenedAt: happenedResult.value,
      valueNumber: null,
      valueText: body.value_text,
      tags: tagsJSON(body.tags),
      objectiveContext: body.objective_context,
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
            valueNumber: entry.amount,
            valueText: null,
            tags: tagsJSON(entry.tags),
            objectiveContext: entry.memo,
            subjectiveInterpretation: null,
          })
          .returning()
        rows.push(fromDB(result[0]))
      }
      return rows
    })
    return { inserted: out.length, records: out, status: 201 }
  } catch (err) {
    console.error('Error creating transaction records:', err)
    return { error: 'Internal server error', status: 500 }
  }
}
