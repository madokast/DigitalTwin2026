import {
  parseHappenedAt,
  type DraftValidationError,
} from '@/lib/draft'
import {
  isValidTag,
  transactionEntryTypeTag,
} from '@/lib/tags'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

export const LOG_TRANSACTION_KEYS = [
  'happened_at',
  'type',
  'entries',
  'suppress_notification',
] as const

export const TRANSACTION_ENTRY_KEYS = [
  'amount',
  'memo',
  'category',
  'subcategory',
] as const

const SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/
/** 金额形态：可选负号、整数或至多两位小数；禁 +、空格、残缺点、前导零 */
const MONEY_AMOUNT = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/

export const MAX_TRANSACTION_ENTRIES = 100

export const AMOUNT_MUST_BE_STRING = 'amount must be a decimal string'
export const INVALID_AMOUNT =
  'Invalid amount: non-zero decimal string, optional leading minus (no plus), at most 2 fractional digits, no spaces; e.g. 10, 10.5, 10.50, -1.5'

export type TransactionType = 'income' | 'expense'

const TRANSACTION_TYPES = new Set<TransactionType>(['income', 'expense'])

export type TransactionEntryInput = {
  amount?: unknown
  memo?: unknown
  category?: unknown
  subcategory?: unknown
}

export type LogTransactionBody = {
  happened_at?: unknown
  type?: unknown
  entries?: unknown
  suppress_notification?: unknown
}

export type NormalizedTransactionEntry = {
  amount: string
  memo: string
  tags: string[]
}

export type NormalizedTransactionBatch = {
  happenedAt: Date
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
export function normalizeMoneyAmount2(s: string): string {
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracPart = dot === -1 ? '' : body.slice(dot + 1)
  return `${neg ? '-' : ''}${intPart}.${fracPart.padEnd(2, '0')}`
}

function parseType(
  raw: unknown,
): { ok: true; value: TransactionType } | DraftValidationError {
  if (raw === undefined || raw === null || raw === '') {
    return { error: 'Missing required field: type' }
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
    return { error: 'Missing required field: amount' }
  }
  if (typeof raw === 'number') {
    return { error: AMOUNT_MUST_BE_STRING }
  }
  if (typeof raw !== 'string') {
    return { error: INVALID_AMOUNT }
  }
  // 禁止 trim：有空格 / 空串均走统一 Invalid amount
  if (!MONEY_AMOUNT.test(raw)) {
    return { error: INVALID_AMOUNT }
  }
  if (isZeroDecimalLiteral(raw)) {
    return { error: INVALID_AMOUNT }
  }
  return { ok: true, value: normalizeMoneyAmount2(raw) }
}

function parseSegment(
  raw: unknown,
  field: 'category' | 'subcategory',
): { ok: true; value: string } | DraftValidationError {
  if (typeof raw !== 'string' || raw === '') {
    return { error: `Missing required field: ${field}` }
  }
  // 与 Go parseSegment 一致：仅 ASCII 空白（空格/Tab/LF/CR），不用 /\s/（会含 \u00a0 等）
  if (/[ \t\n\r]/.test(raw) || raw.includes(':') || !SEGMENT.test(raw)) {
    return {
      error: `Invalid ${field}: must be a single identifier without spaces or colons`,
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

  if (typeof entry.memo !== 'string' || entry.memo === '') {
    return { error: `entries[${index}]: Missing required field: memo` }
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
    return { error: `entries[${index}]: Invalid category/subcategory combination` }
  }

  // 语义：type + 正 amount = 正常；type + 负 amount = 该类型冲销。
  // 整单共用 type；落库 tags 含 transaction_entry:{type}。
  return {
    amount: amountResult.value,
    memo: entry.memo,
    tags: [transactionEntryTypeTag(type), composite],
  }
}

/**
 * 解析 POST /api/log/transaction body。
 * 必填顶层 `type`（income|expense）整单共享；entries 长度 1..MAX；
 * 服务端组装保留前缀 tag `transaction_entry:{type}`。
 * amount：MoneyAmount 正则 → 拒零 → 规范为两位小数入库。
 */
export function parseTransactionBatch(
  body: LogTransactionBody,
): NormalizedTransactionBatch | DraftValidationError {
  const unknown = rejectUnknownKeys(body, LOG_TRANSACTION_KEYS)
  if (unknown) return unknown

  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) return happenedResult

  const typeResult = parseType(body.type)
  if ('error' in typeResult) return typeResult

  if (!Array.isArray(body.entries)) {
    return { error: 'Missing required field: entries (non-empty array)' }
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
    happenedAt: happenedResult.value,
    type: typeResult.value,
    entries,
  }
}
