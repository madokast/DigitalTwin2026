/** API 响应 Record：与 Go `record.Record` JSON 对齐（camelCase + UTC Z） */

export type ApiRecord = {
  id: string
  happenedAt: string
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

type RecordRow = {
  id: string
  happenedAt: Date | string
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

/**
 * 与 Go `record.FormatHappenedAt` 对齐：UTC、毫秒三位、`Z` 后缀。
 * Date 的 `toISOString` 已是该格式；显式转换避免依赖 JSON 序列化副作用。
 */
export function formatHappenedAtUtc(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString()
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    return value
  }
  return d.toISOString()
}

export function toApiRecord(row: RecordRow): ApiRecord {
  return {
    id: row.id,
    happenedAt: formatHappenedAtUtc(row.happenedAt),
    valueNumber: row.valueNumber,
    valueText: row.valueText,
    tags: row.tags,
    objectiveContext: row.objectiveContext,
    subjectiveInterpretation: row.subjectiveInterpretation,
  }
}
