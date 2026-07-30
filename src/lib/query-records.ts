import { and, count, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'

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

function parseIsoDate(raw: string | null, label: string): Date | ParseError | null {
  if (raw === null || raw === '') return null
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

export async function fetchFilteredRecords(parsed: ParsedQuery) {
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
    return { total, page: 1, pageSize: rows.length || 1, records: rows }
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
    records: rows,
  }
}
