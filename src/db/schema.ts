import { pgTable, uuid, timestamp, text, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const records = pgTable('records', {
  id: uuid('id').primaryKey().notNull(),
  happenedAt: timestamp('happened_at', { withTimezone: true }).notNull(),
  // 服务端私有：录入时区 offset 字面量（Z 或 ±HH:MM）；不进对外 JSON
  utcOffset: text('utc_offset').notNull(),
  numericValue: text('numeric_value'),
  rawContent: text('raw_content'),
  objectiveContext: text('objective_context').notNull(),
  aiAnalysis: text('ai_analysis'),
  tags: text('tags').notNull(),
}, (table) => [
  // 确保 numeric_value 和 raw_content 至少填一个
  check('chk_raw_content', sql`${table.numericValue} IS NOT NULL OR ${table.rawContent} IS NOT NULL`),
  // 确保 tags 是有效的 JSON 数组（可为空数组 []）
  check('chk_tags', sql`${table.tags} ~ '^\\[.*\\]$'`),
  // utc_offset：仅规范形 Z 或 ±HH:MM（应用层仍须解析；CHECK 为安全网）
  check(
    'chk_utc_offset',
    sql`${table.utcOffset} = 'Z' OR ${table.utcOffset} ~ '^[+-][0-9]{2}:[0-9]{2}$'`,
  ),
])
