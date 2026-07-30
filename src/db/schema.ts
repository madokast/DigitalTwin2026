import { pgTable, uuid, timestamp, numeric, text, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const records = pgTable('records', {
  id: uuid('id').primaryKey().notNull(),
  happenedAt: timestamp('happened_at', { withTimezone: true }).notNull(),
  valueNumeric: numeric('value_numeric'),
  valueText: text('value_text'),
  tags: text('tags').notNull(),
  context: text('context'),
}, (table) => [
  // 确保 value_numeric 和 value_text 至少填一个
  check('chk_value', sql`${table.valueNumeric} IS NOT NULL OR ${table.valueText} IS NOT NULL`),
  // 确保 tags 是有效的 JSON 数组且不为空
  check('chk_tags', sql`${table.tags} ~ '^\\[.+\\]$'`),
])
