import { validate as uuidValidate } from 'uuid'
import { formatHappenedAt as formatWithUtcOffset } from '@/lib/utcoffset'

/** API 响应 Record：与 Go `record.Record` JSON 对齐（snake_case；时间按 utc_offset 带区） */

export type Record = {
  id: string
  happened_at: string
  /** 仅非 null 时输出该键（text/todo 行省略） */
  numeric_value?: string
  raw_content: string | null
  tags: string[]
  objective_context: string
  ai_analysis: string | null
}

type RecordRow = {
  id: string
  happenedAt: Date | string
  /** 隐列；fromDB 按此格式化 happened_at（对外不可见） */
  utcOffset: string
  numericValue: string | null
  rawContent: string | null
  tags: string
  objectiveContext: string
  aiAnalysis: string | null
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

/** 与 Go `record.FromDB` 对齐：DB 行 → API Record（happened_at = 瞬间 + utc_offset；tags 解析为数组；numeric_value null → 键省略） */
export function fromDB(row: RecordRow): Record {
  return {
    id: row.id,
    happened_at: formatWithUtcOffset(instantOf(row.happenedAt), row.utcOffset),
    ...(row.numericValue !== null ? { numeric_value: row.numericValue } : {}),
    raw_content: row.rawContent,
    objective_context: row.objectiveContext,
    ai_analysis: row.aiAnalysis,
    tags: parseTagsField(row.tags),
  }
}

/** 与 Go `record.TagsJSON` 对齐：tags 数组 → JSON 字符串 */
export function tagsJSON(tags: string[]): string {
  return JSON.stringify(tags)
}

/** DB text 列 → tags 数组；chk_tags 保证 JSON 数组形（可为 []），parse 失败按空数组兜底 */
export function parseTagsField(tags: string): string[] {
  try {
    const parsed: unknown = JSON.parse(tags)
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string')
    }
  } catch {
    // fallthrough
  }
  return []
}

/** 与 Go `record.InvalidID` 同文案：非 UUID → 400，避免 PG 类型错误变 500 */
export const INVALID_RECORD_ID = 'Invalid record id'

/**
 * 与 Go `record.IsValidID` 对齐：npm `uuid.validate`
 *（version nibble [1-8]、variant [89ab]；另允 nil / max UUID）。
 */
export function isValidRecordId(id: string): boolean {
  return uuidValidate(id)
}
