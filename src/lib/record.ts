import { validate as uuidValidate } from 'uuid'
import { formatHappenedAt as formatWithUtcOffset } from '@/lib/utcoffset'

/** 领域对象 = 对外 JSON 形状（时间轴操作全在 Repository SQL 内，业务层只消费带区串）。 */

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

/** 数据库直接映射结构（写路径入参 / drizzle 行）：utc_offset 隐列 + tags 为 DB JSON 字符串。
 * 业务层 parse 请求的产物（Date + offset）直接填充，零字符串往返。与 Go `record.DBRow` 同构。 */
export type DBRow = {
  id: string
  happenedAt: Date
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

/** drizzle 行 / DBRow → 领域 Record：唯一转换点（瞬间 + 隐列 → 带区串；tags JSON → 数组）。与 Go `FromDB` 对称。 */
export function fromDB(row: DBRow): Record {
  return {
    id: row.id,
    happened_at: formatWithUtcOffset(row.happenedAt, row.utcOffset),
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
export const INVALID_RECORD_ID = 'invalid record id'

/**
 * 与 Go `record.IsValidID` 对齐：npm `uuid.validate`
 *（version nibble [1-8]、variant [89ab]；另允 nil / max UUID）。
 */
export function isValidRecordId(id: string): boolean {
  return uuidValidate(id)
}
