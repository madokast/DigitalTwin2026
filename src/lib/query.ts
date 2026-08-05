import { and, count, eq, gte, like, lt, or, sql, type SQL } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import {
  fromDB,
  INVALID_RECORD_ID,
  isValidRecordId,
  type Record as DomainRecord,
} from '@/lib/record'
import { aggregateTagCounts, type TagCount } from '@/lib/tags'
import {
  getZonedDayBounds,
  isValidTimeZone,
  parseRFC3339Flexible,
} from '@/lib/timeutil'
import {
  shouldDeformTodoRecordTags,
  toTodoRecordJson,
  type TodoRecordJson,
} from '@/lib/tododraft'

/**
 * 列表查询排序（与 Go `query`、`testdata/query-records-list-order.json` 对齐）。
 * `sort_by`: `happened_at`（默认）| `id`；`sort_order`: `asc`（默认）| `desc`（严格小写）。
 * happened_at desc 时次键 id 恒 ASC；id 排序无次键。
 */
export type SortBy = 'happened_at' | 'id'
export type SortOrder = 'asc' | 'desc'

export function recordsOrderBySql(sortBy: SortBy, sortOrder: SortOrder): string {
  if (sortBy === 'id') {
    return sortOrder === 'desc' ? 'id DESC' : 'id ASC'
  }
  return sortOrder === 'desc' ? 'happened_at DESC, id ASC' : 'happened_at ASC, id ASC'
}

export type ParsedQuery = {
  conditions: SQL[]
  id: string | null
  page: number
  pageSize: number
  sortBy: SortBy
  sortOrder: SortOrder
  /** 裸保留前缀 tag（恒空毒化交集）时给 AI 的纠正提示；无则 undefined */
  hint?: string
}

export type ParseError = { error: string }

/**
 * `tag` 查询值仅两种合法形态：合法 tag 名（无 `*`）或族通配 `tag名:*`。
 * 含 `*` 且非 `合法tag名:*`（裸 `*`、中间 `*`、多个 `*`、末尾无冒号）→ 400。
 * 与 Go `query.ParseRecordQueryParams` 同文案同判定。
 */
export const INVALID_TAG_QUERY =
  'Invalid tag query "%s": use a valid tag name or a family pattern "tag=review:*" (a single "*" at the end, prefix must be non-empty)'

/** `*` 仅允许作为 `合法tag名:*` 尾缀；`*` 之前必须是合法 tag 名加冒号 */
const TAG_QUERY_WILDCARD = /^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*:\*$/

/** 裸值永不被写入的保留前缀：query?tag=<这些值> 恒空，应提示用族通配。body:weight 例外（裸值即真实 tag）。 */
export const BARE_RESERVED_TAG_HINTS = ['transaction_entry', 'todo', 'review'] as const

/**
 * 转义 LIKE 通配符，使字面量匹配（PostgreSQL 默认 ESCAPE '\'）。
 * 与 Go `query.EscapeLikePattern` 对齐：先 `\`，再 `%` / `_`。
 */
export function escapeLikePattern(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

function parsePositiveInt(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  // 与 Go 对齐：须为安全整数（拒绝 float 精度丢失 / 超大字面量）
  if (!Number.isSafeInteger(n) || n < 1) return null
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
  const d = parseRFC3339Flexible(raw)
  if (!d) {
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

  const pageSize = parsePositiveInt(searchParams.get('page_size'), 20)
  if (pageSize === null || pageSize > 100) {
    return { error: 'page_size must be an integer between 1 and 100' }
  }

  const sortByRaw = searchParams.get('sort_by')
  if (sortByRaw !== null && sortByRaw !== 'happened_at' && sortByRaw !== 'id') {
    return { error: 'sort_by must be one of: happened_at, id' }
  }
  const sortOrderRaw = searchParams.get('sort_order')
  if (sortOrderRaw !== null && sortOrderRaw !== 'asc' && sortOrderRaw !== 'desc') {
    return { error: 'sort_order must be one of: asc, desc' }
  }
  const sortBy: SortBy = sortByRaw ?? 'happened_at'
  const sortOrder: SortOrder = sortOrderRaw ?? 'asc'

  const from = parseIsoDate(searchParams.get('from'), 'from')
  if (from && 'error' in from) return from
  const to = parseIsoDate(searchParams.get('to'), 'to')
  if (to && 'error' in to) return to

  const conditions: SQL[] = []
  const id = searchParams.get('id')
  let hint: string | undefined

  if (id) {
    if (!isValidRecordId(id)) {
      return { error: INVALID_RECORD_ID }
    }
    conditions.push(eq(records.id, id))
  }

  if (from instanceof Date) {
    conditions.push(gte(records.happenedAt, from))
  }
  if (to instanceof Date) {
    conditions.push(lt(records.happenedAt, to))
  }

  for (const tag of searchParams.getAll('tag')) {
    if (!tag) continue
    if (tag.includes('*')) {
      // 仅 `合法tag名:*` 合法；其余含 `*` 形态（裸/中间/多个/无冒号尾）→ 400
      if (!TAG_QUERY_WILDCARD.test(tag)) {
        return { error: INVALID_TAG_QUERY.replace('%s', tag) }
      }
      // 族通配 `X:*` → `%"X:%`（去尾闭合引号、保留冒号）
      conditions.push(
        like(records.tags, `%"${escapeLikePattern(tag.slice(0, -1))}%`),
      )
    } else {
      // 裸保留前缀恒空：记录首个命中，供响应加 hint（AI 纠错）
      if (!hint && (BARE_RESERVED_TAG_HINTS as readonly string[]).includes(tag)) {
        hint = `Use "tag=${tag}:*" to match ${tag} records (the bare tag "${tag}" is reserved and never stored)`
      }
      conditions.push(like(records.tags, `%"${escapeLikePattern(tag)}"%`))
    }
  }

  const q = searchParams.get('q')
  if (q) {
    const searchPattern = `%${escapeLikePattern(q)}%`
    // 必须用 or() 包一层，否则 and(...conds) 拼出 tag AND vt OR obj …（AND 优先于 OR）
    conditions.push(
      or(
        like(records.rawContent, searchPattern),
        like(records.objectiveContext, searchPattern),
        like(records.aiAnalysis, searchPattern),
        like(records.tags, searchPattern),
      )!,
    )
  }

  return { conditions, id, page, pageSize, sortBy, sortOrder, hint }
}

/** 与 Go `query.FetchResult` 同构：lib 内完成 FromDB 映射 */
export type FetchResult = {
  total: number
  page: number
  pageSize: number
  records: DomainRecord[]
}

/** GET /api/query `records[]` 元素：待办行变形，其余默认 Record */
export type QueryRecordJson = DomainRecord | TodoRecordJson

/**
 * 查询响应单行序列化（与 Go `query.ToQueryRecordJSON` 对齐）。
 * 查询侧略宽：至少一枚四态 tag → TodoRecord；审计行与其它行保持默认 Record。
 */
export function toQueryRecordJson(rec: DomainRecord): QueryRecordJson {
  if (shouldDeformTodoRecordTags(rec.tags)) {
    return toTodoRecordJson(rec)
  }
  return rec
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

  const listOrder = sql.raw(
    recordsOrderBySql(parsed.sortBy, parsed.sortOrder),
  )

  // 有 id 时忽略分页，返回 0～1 条
  if (parsed.id) {
    const rows = where
      ? await db.select().from(records).where(where).orderBy(listOrder)
      : await db.select().from(records).orderBy(listOrder)
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
        .orderBy(listOrder)
        .limit(parsed.pageSize)
        .offset(offset)
    : await db
        .select()
        .from(records)
        .orderBy(listOrder)
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

/** 全表 tags 字段聚合计数（与 Go FetchTagCounts 同构）；prefix 非空时真前缀过滤 */
export async function fetchTagCounts(prefix = ''): Promise<TagCount[]> {
  const rows = await db.select({ tags: records.tags }).from(records)
  return aggregateTagCounts(
    rows.map((row) => row.tags),
    prefix,
  )
}

// --- GET /api/query/transaction/summary ---

const TX_ENTRY_INCOME = 'transaction_entry:income'
const TX_ENTRY_EXPENSE = 'transaction_entry:expense'
/** 与 transactiondraft SEGMENT 一致：恰好一对 category:subcategory */
const CATEGORY_PAIR =
  /^([a-zA-Z_][a-zA-Z0-9_]*):([a-zA-Z_][a-zA-Z0-9_]*)$/
/** 小数最多 10 位小数；聚合用定点数，避免 float */
const DECIMAL_FRAC_SCALE = 10

export type MoneyBucket = { sum: string; count: number }

export type SubcategoryBucket = {
  subcategory: string
  sum: string
  count: number
}

export type CategoryBucket = {
  category: string
  sum: string
  count: number
  subcategories: SubcategoryBucket[]
}

export type TransactionSummaryResult = {
  success: true
  from: string
  to: string
  income: MoneyBucket
  expense: MoneyBucket
  net: string
  income_categories: CategoryBucket[]
  expense_categories: CategoryBucket[]
}

export type TransactionSummaryRow = {
  tags: string
  numeric_value: string | null
}

export type ParsedTransactionSummaryRange = {
  fromRaw: string
  toRaw: string
  from: Date
  to: Date
}

/** 解析强制 from/to；半开区间要求 from < to（与 Go ParseTransactionSummaryParams 同文案） */
export function parseTransactionSummaryParams(
  searchParams: URLSearchParams,
): ParsedTransactionSummaryRange | ParseError {
  const fromRaw = searchParams.get('from')
  if (fromRaw === null || fromRaw === '') {
    return { error: 'Missing required query parameter: from' }
  }
  const toRaw = searchParams.get('to')
  if (toRaw === null || toRaw === '') {
    return { error: 'Missing required query parameter: to' }
  }

  const from = parseIsoDate(fromRaw, 'from')
  if (from && 'error' in from) return from
  if (!(from instanceof Date)) {
    return { error: 'Missing required query parameter: from' }
  }
  const to = parseIsoDate(toRaw, 'to')
  if (to && 'error' in to) return to
  if (!(to instanceof Date)) {
    return { error: 'Missing required query parameter: to' }
  }

  if (from.getTime() >= to.getTime()) {
    return { error: 'from must be earlier than to' }
  }

  return { fromRaw, toRaw, from, to }
}

/** 解析十进制字面量为 scale=10 的定点 BigInt；非法 → null（跳过该行） */
function parseDecimalScaled(s: string): bigint | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return null
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [intPart, fracPart = ''] = body.split('.')
  if (fracPart.length > DECIMAL_FRAC_SCALE) return null
  if (intPart.length > 28) return null
  const padded = fracPart.padEnd(DECIMAL_FRAC_SCALE, '0')
  try {
    const n = BigInt(intPart + padded)
    return neg ? -n : n
  } catch {
    return null
  }
}

/**
 * 定点金额 → 恰好两位小数字符串。
 * 舍入：half away from zero（与 Go big.Rat.FloatString(2) 一致）。
 */
function formatMoney2(scaled: bigint): string {
  const div = 10n ** BigInt(DECIMAL_FRAC_SCALE - 2)
  const half = div / 2n
  const q = scaled >= 0n ? (scaled + half) / div : (scaled - half) / div
  const neg = q < 0n
  const abs = neg ? -q : q
  const intPart = abs / 100n
  const frac = abs % 100n
  return `${neg ? '-' : ''}${intPart}.${frac.toString().padStart(2, '0')}`
}

type AccBucket = { sum: bigint; count: number }

function emptyAcc(): AccBucket {
  return { sum: 0n, count: 0 }
}

function classifyEntryType(
  tags: string[],
): 'income' | 'expense' | null {
  let type: 'income' | 'expense' | null = null
  for (const tag of tags) {
    if (tag === TX_ENTRY_INCOME) {
      if (type !== null) return null
      type = 'income'
    } else if (tag === TX_ENTRY_EXPENSE) {
      if (type !== null) return null
      type = 'expense'
    }
  }
  return type
}

function findCategoryPair(
  tags: string[],
): { category: string; subcategory: string } | null {
  for (const tag of tags) {
    if (tag.startsWith('transaction_entry:') || tag === 'transaction_entry') {
      continue
    }
    const m = CATEGORY_PAIR.exec(tag)
    if (m) {
      return { category: m[1], subcategory: m[2] }
    }
  }
  return null
}

function sortBucketsBySumThenName<T extends { sum: bigint; name: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (a.sum !== b.sum) return a.sum > b.sum ? -1 : 1
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })
}

/**
 * 内存聚合 transaction_entry 行（与 Go AggregateTransactionSummary 同构）。
 * 脏行（无合法 category:subcategory / 无 numeric_value / 非法字面量）跳过。
 * 非法 tags JSON / 非数组抛错（HTTP 500）。
 */
export function aggregateTransactionSummary(
  rows: TransactionSummaryRow[],
  fromRaw: string,
  toRaw: string,
): TransactionSummaryResult {
  const income = emptyAcc()
  const expense = emptyAcc()
  const incomeCats = new Map<
    string,
    { sum: bigint; count: number; subs: Map<string, AccBucket> }
  >()
  const expenseCats = new Map<
    string,
    { sum: bigint; count: number; subs: Map<string, AccBucket> }
  >()

  const addTo = (
    side: 'income' | 'expense',
    category: string,
    subcategory: string,
    amount: bigint,
  ) => {
    const top = side === 'income' ? income : expense
    top.sum += amount
    top.count += 1
    const cats = side === 'income' ? incomeCats : expenseCats
    let cat = cats.get(category)
    if (!cat) {
      cat = { sum: 0n, count: 0, subs: new Map() }
      cats.set(category, cat)
    }
    cat.sum += amount
    cat.count += 1
    let sub = cat.subs.get(subcategory)
    if (!sub) {
      sub = emptyAcc()
      cat.subs.set(subcategory, sub)
    }
    sub.sum += amount
    sub.count += 1
  }

  for (const row of rows) {
    const parsed: unknown = JSON.parse(row.tags)
    if (!Array.isArray(parsed)) {
      throw new Error('tags field is not a JSON array')
    }
    const tags = parsed.filter((t): t is string => typeof t === 'string')
    const entryType = classifyEntryType(tags)
    if (!entryType) continue
    const pair = findCategoryPair(tags)
    if (!pair) continue
    if (row.numeric_value === null || row.numeric_value === '') continue
    const amount = parseDecimalScaled(row.numeric_value)
    if (amount === null) continue
    addTo(entryType, pair.category, pair.subcategory, amount)
  }

  const toCategories = (
    cats: Map<string, { sum: bigint; count: number; subs: Map<string, AccBucket> }>,
  ): CategoryBucket[] => {
    const list = [...cats.entries()].map(([category, cat]) => ({
      name: category,
      sum: cat.sum,
      count: cat.count,
      subs: cat.subs,
    }))
    return sortBucketsBySumThenName(list).map((cat) => {
      const subs = [...cat.subs.entries()].map(([subcategory, sub]) => ({
        name: subcategory,
        sum: sub.sum,
        count: sub.count,
      }))
      return {
        category: cat.name,
        sum: formatMoney2(cat.sum),
        count: cat.count,
        subcategories: sortBucketsBySumThenName(subs).map((s) => ({
          subcategory: s.name,
          sum: formatMoney2(s.sum),
          count: s.count,
        })),
      }
    })
  }

  const netScaled = income.sum - expense.sum
  return {
    success: true,
    from: fromRaw,
    to: toRaw,
    income: { sum: formatMoney2(income.sum), count: income.count },
    expense: { sum: formatMoney2(expense.sum), count: expense.count },
    net: formatMoney2(netScaled),
    income_categories: toCategories(incomeCats),
    expense_categories: toCategories(expenseCats),
  }
}

/** 拉取区间内候选行并聚合（与 Go FetchTransactionSummary 同构） */
export async function fetchTransactionSummary(
  from: Date,
  to: Date,
  fromRaw: string,
  toRaw: string,
): Promise<TransactionSummaryResult> {
  const incomeLike = `%"${escapeLikePattern(TX_ENTRY_INCOME)}"%`
  const expenseLike = `%"${escapeLikePattern(TX_ENTRY_EXPENSE)}"%`
  const rows = await db
    .select({
      tags: records.tags,
      numericValue: records.numericValue,
    })
    .from(records)
    .where(
      and(
        gte(records.happenedAt, from),
        lt(records.happenedAt, to),
        or(like(records.tags, incomeLike), like(records.tags, expenseLike)),
      ),
    )

  return aggregateTransactionSummary(
    rows.map((r) => ({
      tags: r.tags,
      numeric_value: r.numericValue,
    })),
    fromRaw,
    toRaw,
  )
}
