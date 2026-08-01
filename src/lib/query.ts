import { and, count, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import { fromDB, type Record } from '@/lib/record'
import { aggregateTagCounts } from '@/lib/tags'
import { getZonedDayBounds, isValidTimeZone } from '@/lib/timeutil'

export type ParsedQuery = {
  conditions: SQL[]
  id: string | null
  page: number
  pageSize: number
}

export type ParseError = { error: string }

function parsePositiveInt(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

/** ISO 8601 末尾时区：Z / ±HH:MM / ±HHMM */
const ISO_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i

function parseIsoDate(raw: string | null, label: string): Date | ParseError | null {
  if (raw === null || raw === '') return null
  if (!ISO_TZ_SUFFIX.test(raw)) {
    return {
      error: `${label} must be ISO 8601 with timezone (Z or ±HH:MM)`,
    }
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    return { error: `Invalid ${label} datetime` }
  }
  return d
}

/** 从 URLSearchParams 解析过滤与分页；失败返回 { error } */
export function parseRecordQueryParams(
  searchParams: URLSearchParams,
): ParsedQuery | ParseError {
  const page = parsePositiveInt(searchParams.get('page'), 1)
  if (page === null) {
    return { error: 'page must be a positive integer' }
  }

  const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20)
  if (pageSize === null || pageSize > 100) {
    return { error: 'pageSize must be an integer between 1 and 100' }
  }

  const from = parseIsoDate(searchParams.get('from'), 'from')
  if (from && 'error' in from) return from
  const to = parseIsoDate(searchParams.get('to'), 'to')
  if (to && 'error' in to) return to

  const conditions: SQL[] = []
  const id = searchParams.get('id')

  if (id) {
    conditions.push(eq(records.id, id))
  }

  if (from instanceof Date) {
    conditions.push(gte(records.happenedAt, from))
  }
  if (to instanceof Date) {
    conditions.push(lt(records.happenedAt, to))
  }

  for (const tag of searchParams.getAll('tag')) {
    if (tag) {
      conditions.push(like(records.tags, `%"${tag}"%`))
    }
  }

  const q = searchParams.get('q')
  if (q) {
    const searchPattern = `%${q}%`
    conditions.push(
      sql`${records.valueText} LIKE ${searchPattern} OR ${records.objectiveContext} LIKE ${searchPattern} OR ${records.subjectiveInterpretation} LIKE ${searchPattern} OR ${records.tags} LIKE ${searchPattern}`,
    )
  }

  return { conditions, id, page, pageSize }
}

/** 与 Go `query.FetchResult` 同构：lib 内完成 FromDB 映射 */
export type FetchResult = {
  total: number
  page: number
  pageSize: number
  records: Record[]
}

export async function fetchFilteredRecords(
  parsed: ParsedQuery,
): Promise<FetchResult> {
  const where =
    parsed.conditions.length > 0 ? and(...parsed.conditions) : undefined

  const [countRow] = where
    ? await db.select({ value: count() }).from(records).where(where)
    : await db.select({ value: count() }).from(records)

  const total = Number(countRow?.value ?? 0)

  // 有 id 时忽略分页，返回 0～1 条
  if (parsed.id) {
    const rows = where
      ? await db.select().from(records).where(where).orderBy(desc(records.happenedAt))
      : await db.select().from(records).orderBy(desc(records.happenedAt))
    return {
      total,
      page: 1,
      pageSize: rows.length || 1,
      records: rows.map(fromDB),
    }
  }

  const offset = (parsed.page - 1) * parsed.pageSize
  const rows = where
    ? await db
        .select()
        .from(records)
        .where(where)
        .orderBy(desc(records.happenedAt))
        .limit(parsed.pageSize)
        .offset(offset)
    : await db
        .select()
        .from(records)
        .orderBy(desc(records.happenedAt))
        .limit(parsed.pageSize)
        .offset(offset)

  return {
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
    records: rows.map(fromDB),
  }
}

export type SummaryResult = {
  total: number
  today: number
  tz: string
}

/** 汇总 total / 今日条数；tz 非法时返回 { error }（与 Go FetchSummary 同文案） */
export async function fetchSummary(
  tz: string,
  now: Date = new Date(),
): Promise<SummaryResult | { error: string }> {
  if (!tz || !isValidTimeZone(tz)) {
    return { error: 'Query parameter tz must be a valid IANA time zone' }
  }

  const { start, end } = getZonedDayBounds(now, tz)

  const [totalRow] = await db.select({ value: count() }).from(records)
  const [todayRow] = await db
    .select({ value: count() })
    .from(records)
    .where(and(gte(records.happenedAt, start), lt(records.happenedAt, end)))

  return {
    total: Number(totalRow?.value ?? 0),
    today: Number(todayRow?.value ?? 0),
    tz,
  }
}

/** 全表 tags 字段聚合计数（与 Go FetchTagCounts 同构） */
export async function fetchTagCounts(): Promise<Record<string, number>> {
  const rows = await db.select({ tags: records.tags }).from(records)
  return aggregateTagCounts(rows.map((row) => row.tags))
}
