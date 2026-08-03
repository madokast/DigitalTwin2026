import { pgTable, uuid, timestamp, text, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const records = pgTable('records', {
  id: uuid('id').primaryKey().notNull(),
  happenedAt: timestamp('happened_at', { withTimezone: true }).notNull(),
  // 服务端私有：录入时区 offset 字面量（Z 或 ±HH:MM）；不进对外 JSON
  utcOffset: text('utc_offset').notNull(),
  valueNumber: text('value_number'),
  valueText: text('value_text'),
  tags: text('tags').notNull(),
  objectiveContext: text('objective_context').notNull(),
  subjectiveInterpretation: text('subjective_interpretation'),
}, (table) => [
  // 确保 value_number 和 value_text 至少填一个
  check('chk_value', sql`${table.valueNumber} IS NOT NULL OR ${table.valueText} IS NOT NULL`),
  // 确保 tags 是有效的 JSON 数组且不为空
  check('chk_tags', sql`${table.tags} ~ '^\\[.+\\]$'`),
  // utc_offset：仅规范形 Z 或 ±HH:MM（应用层仍须解析；CHECK 为安全网）
  check(
    'chk_utc_offset',
    sql`${table.utcOffset} = 'Z' OR ${table.utcOffset} ~ '^[+-][0-9]{2}:[0-9]{2}$'`,
  ),
])
