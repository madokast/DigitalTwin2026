import { eq } from 'drizzle-orm'
import { validate as uuidValidate } from 'uuid'
import db from '@/db'
import { records } from '@/db/schema'
import type { NormalizedRecordDraft } from '@/lib/draft'
import { formatHappenedAt as formatWithUtcOffset } from '@/lib/utcoffset'

/** API 响应 Record：与 Go `record.Record` JSON 对齐（snake_case；时间按 utc_offset 带区） */

export type Record = {
  id: string
  happened_at: string
  value_number: string | null
  value_text: string | null
  tags: string
  objective_context: string
  subjective_interpretation: string | null
}

type RecordRow = {
  id: string
  happenedAt: Date | string
  /** 隐列；fromDB 按此格式化 happened_at（对外不可见） */
  utcOffset: string
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

/**
 * 一律 UTC Z（无 offset）。**仅**作隐列损坏时的 FromDB 回退；
 * 生产读路径必须用 `fromDB` / `utcoffset.formatHappenedAt(instant, utc_offset)`。
 * 与 Go `record.FormatHappenedAt`（无 offset 重载）对齐。
 */
export function formatHappenedAt(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString()
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    return value
  }
  return d.toISOString()
}

function instantOf(value: Date | string): Date {
  if (value instanceof Date) return value
  return new Date(value)
}

/** 与 Go `record.FromDB` 对齐：DB 行 → API Record（happened_at = 瞬间 + utc_offset） */
export function fromDB(row: RecordRow): Record {
  return {
    id: row.id,
    happened_at: formatWithUtcOffset(instantOf(row.happenedAt), row.utcOffset),
    value_number: row.valueNumber,
    value_text: row.valueText,
    tags: row.tags,
    objective_context: row.objectiveContext,
    subjective_interpretation: row.subjectiveInterpretation,
  }
}

/** 与 Go `record.TagsJSON` 对齐：tags 数组 → JSON 字符串 */
export function tagsJSON(tags: string[]): string {
  return JSON.stringify(tags)
}

export type UpdateRecordResult =
  | { record: Record; status: 200 }
  | { error: string; status: number }

/** 与 Go `record.ErrNotFound` 同文案 */
export const RECORD_NOT_FOUND = 'Record not found'

/** 与 Go `record.InvalidID` 同文案：非 UUID → 400，避免 PG 类型错误变 500 */
export const INVALID_RECORD_ID = 'Invalid record id'

/**
 * 与 Go `record.IsValidID` 对齐：npm `uuid.validate`
 *（version nibble [1-8]、variant [89ab]；另允 nil / max UUID）。
 */
export function isValidRecordId(id: string): boolean {
  return uuidValidate(id)
}

/**
 * update 可注入的写库边界（与 Go `db.Querier` 假实现对称）。
 * 返回更新后行；无匹配行返回 `undefined`（映射 404）。
 * happenedAt / utcOffset 仅在请求带时间键时传入（§7）。
 */
export type UpdateDb = {
  updateReturning: (
    id: string,
    values: {
      happenedAt?: Date
      utcOffset?: string
      valueNumber: string | null
      valueText: string | null
      tags: string
      objectiveContext: string
      subjectiveInterpretation: string | null
    },
  ) => Promise<RecordRow | undefined>
}

const defaultUpdateDb: UpdateDb = {
  async updateReturning(id, values) {
    const result = await db
      .update(records)
      .set(values)
      .where(eq(records.id, id))
      .returning()
    return result[0]
  },
}

/**
 * 按已归一化草稿更新一条记录。
 * 与 Go `record.Update` 对齐：成功 `{ record, status: 200 }`；不存在 `{ error, status: 404 }`。
 * 带 happenedAt → 重算写入 utc_offset；省略 → 两列都不动（§7）。
 * 可选 `store`：测试注入；生产调用方省略即可。
 */
export async function update(
  id: string,
  d: NormalizedRecordDraft,
  store: UpdateDb = defaultUpdateDb,
): Promise<UpdateRecordResult> {
  if (!isValidRecordId(id)) {
    return { error: INVALID_RECORD_ID, status: 400 }
  }

  try {
    const values: Parameters<UpdateDb['updateReturning']>[1] = {
      valueNumber: d.valueNumber,
      valueText: d.valueText,
      tags: tagsJSON(d.tags),
      objectiveContext: d.objectiveContext,
      subjectiveInterpretation: d.subjectiveInterpretation,
    }
    if (d.happenedAt !== null && d.utcOffset !== null) {
      values.happenedAt = d.happenedAt
      values.utcOffset = d.utcOffset
    }

    const row = await store.updateReturning(id, values)

    if (!row) {
      return { error: RECORD_NOT_FOUND, status: 404 }
    }
    return { record: fromDB(row), status: 200 }
  } catch (err) {
    console.error('Error patching record:', err)
    return { error: 'Internal server error', status: 500 }
  }
}
