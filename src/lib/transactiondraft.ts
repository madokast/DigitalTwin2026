import {
  parseHappenedAt,
  requireTrimmedText,
  type DraftValidationError,
} from '@/lib/draft'
import {
  isValidTag,
  transactionEntryTypeTag,
} from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

export const LOG_TRANSACTIONS_KEYS = [
  'happened_at',
  'type',
  'entries',
] as const

export const TRANSACTION_ENTRY_KEYS = [
  'amount',
  'memo',
  'category',
  'subcategory',
] as const

const SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/
/** 金额形态：可选负号、整数至多 12 位或至多两位小数；禁 +、空格、残缺点、前导零；绝对值 ≤ 999999999999.99 */
const MONEY_AMOUNT = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/

export const MAX_TRANSACTION_ENTRIES = 100

export const AMOUNT_MUST_BE_STRING = 'amount must be a decimal string'
export const INVALID_AMOUNT =
  'invalid amount: non-zero decimal string, optional leading minus (no plus), at most 2 fractional digits, absolute value at most 999999999999.99, no spaces; e.g. 10, 10.5, 10.50, -1.5'

export type TransactionType = 'income' | 'expense'

const TRANSACTION_TYPES = new Set<TransactionType>(['income', 'expense'])

export type TransactionEntryInput = {
  amount?: unknown
  memo?: unknown
  category?: unknown
  subcategory?: unknown
}

export type LogTransactionsBody = {
  happened_at?: unknown
  type?: unknown
  entries?: unknown
}

export type NormalizedTransactionEntry = {
  amount: string
  memo: string
  tags: string[]
}

export type NormalizedTransactionBatch = {
  /** 已校验的 happened_at 请求串（Repository 内解析落库） */
  happenedAtRaw: string
  type: TransactionType
  entries: NormalizedTransactionEntry[]
}

/** 已通过金额正则的字面量是否为零（含 -0 / 0.00） */
export function isZeroDecimalLiteral(s: string): boolean {
  const digits = s.replace(/^-/, '').replace('.', '')
  return digits.length > 0 && /^0+$/.test(digits)
}

/**
 * 将已通过金额校验的字面量规范为恰好两位小数（字符串补齐，禁止 float）。
 * 例：`10` → `10.00`，`10.5` → `10.50`，`-1.5` → `-1.50`。
 */
export function normalizeMoneyAmount(s: string): string {
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracPart = dot === -1 ? '' : body.slice(dot + 1)
  return `${neg ? '-' : ''}${intPart}.${fracPart.padEnd(2, '0')}`
}

/**
 * 恰好两位小数字符串列表 → 代数合计（定点分，无 float；与 summary 一致）。
 * 例：["12.50","-3.00"] → "9.50"。
 */
export function sumMoneyAmounts(amounts: string[]): string {
  let cents = 0n
  for (const amount of amounts) {
    cents += BigInt(amount.replace('.', ''))
  }
  const neg = cents < 0n
  const abs = neg ? -cents : cents
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

function parseType(
  raw: unknown,
): { ok: true; value: TransactionType } | DraftValidationError {
  if (raw === undefined || raw === null || raw === '') {
    return { error: 'missing required field: type' }
  }
  if (typeof raw !== 'string' || !TRANSACTION_TYPES.has(raw as TransactionType)) {
    return { error: 'type must be "income" or "expense"' }
  }
  return { ok: true, value: raw as TransactionType }
}

function parseAmount(
  raw: unknown,
): { ok: true; value: string } | DraftValidationError {
  if (raw === undefined || raw === null) {
    return { error: 'missing required field: amount' }
  }
  if (typeof raw === 'number') {
    return { error: AMOUNT_MUST_BE_STRING }
  }
  if (typeof raw !== 'string') {
    return { error: INVALID_AMOUNT }
  }
  // trim 后校验；存 trim 后值（与 numeric_value 一致）
  const trimmed = raw.trim()
  if (!MONEY_AMOUNT.test(trimmed)) {
    return { error: INVALID_AMOUNT }
  }
  if (isZeroDecimalLiteral(trimmed)) {
    return { error: INVALID_AMOUNT }
  }
  return { ok: true, value: normalizeMoneyAmount(trimmed) }
}

function parseSegment(
  raw: unknown,
  field: 'category' | 'subcategory',
): { ok: true; value: string } | DraftValidationError {
  if (typeof raw !== 'string' || raw === '') {
    return { error: `missing required field: ${field}` }
  }
  // 与 Go parseSegment 一致：仅 ASCII 空白（空格/Tab/LF/CR），不用 /\s/（会含 \u00a0 等）
  if (/[ \t\n\r]/.test(raw) || raw.includes(':') || !SEGMENT.test(raw)) {
    return {
      error: `invalid ${field}: must be a single identifier without spaces or colons`,
    }
  }
  return { ok: true, value: raw }
}

function parseEntry(
  raw: unknown,
  index: number,
  type: TransactionType,
): NormalizedTransactionEntry | DraftValidationError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `entries[${index}] must be an object` }
  }
  const unknown = rejectUnknownKeys(raw, TRANSACTION_ENTRY_KEYS)
  if (unknown) {
    return { error: `entries[${index}]: ${unknown.error}` }
  }
  const entry = raw as TransactionEntryInput

  const amountResult = parseAmount(entry.amount)
  if ('error' in amountResult) {
    return { error: `entries[${index}]: ${amountResult.error}` }
  }

  const memoResult = requireTrimmedText(entry.memo, 'memo')
  if ('error' in memoResult) {
    return { error: `entries[${index}]: ${memoResult.error}` }
  }

  const categoryResult = parseSegment(entry.category, 'category')
  if ('error' in categoryResult) {
    return { error: `entries[${index}]: ${categoryResult.error}` }
  }
  const subcategoryResult = parseSegment(entry.subcategory, 'subcategory')
  if ('error' in subcategoryResult) {
    return { error: `entries[${index}]: ${subcategoryResult.error}` }
  }

  const composite = `${categoryResult.value}:${subcategoryResult.value}`
  if (!isValidTag(composite)) {
    return { error: `entries[${index}]: invalid category/subcategory combination` }
  }

  // 语义：type + 正 amount = 正常；type + 负 amount = 该类型冲销。
  // 整单共用 type；落库 tags 含 transaction_entry:{type}。
  return {
    amount: amountResult.value,
    memo: memoResult.value,
    tags: [transactionEntryTypeTag(type), composite],
  }
}

/**
 * 解析 POST /api/log/transactions body。
 * 必填顶层 `type`（income|expense）整单共享；entries 长度 1..MAX；
 * 服务端组装保留前缀 tag `transaction_entry:{type}`。
 * amount：MoneyAmount 正则（含绝对值上限）→ 拒零 → 规范为两位小数入库。
 */
export function parseTransactionBatch(
  body: LogTransactionsBody,
): NormalizedTransactionBatch | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_TRANSACTIONS_KEYS)
  if (unknown) return unknown

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) return happenedResult
  const happenedAtRaw = body.happened_at as string

  const typeResult = parseType(body.type)
  if ('error' in typeResult) return typeResult

  if (!Array.isArray(body.entries)) {
    return { error: 'missing required field: entries (non-empty array)' }
  }
  if (body.entries.length === 0) {
    return { error: 'entries must be a non-empty array' }
  }
  if (body.entries.length > MAX_TRANSACTION_ENTRIES) {
    return {
      error: `entries must contain at most ${MAX_TRANSACTION_ENTRIES} items`,
    }
  }

  const entries: NormalizedTransactionEntry[] = []
  for (let i = 0; i < body.entries.length; i++) {
    const parsed = parseEntry(body.entries[i], i, typeResult.value)
    if ('error' in parsed) return parsed
    entries.push(parsed)
  }

  return {
    happenedAtRaw,
    type: typeResult.value,
    entries,
  }
}
