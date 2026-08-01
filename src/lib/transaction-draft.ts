import {
  parseHappenedAt,
  validateDecimalString,
  VALUE_NUMBER_MUST_BE_STRING,
  type DraftValidationError,
} from '@/lib/record-draft'
import {
  RESERVED_TAG_TRANSACTION_ENTRY,
  isValidTag,
} from '@/lib/tags'

const SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/
export const MAX_TRANSACTION_ENTRIES = 100

export const AMOUNT_MUST_BE_STRING = 'amount must be a decimal string'

export type TransactionEntryInput = {
  amount?: unknown
  memo?: unknown
  category?: unknown
  subcategory?: unknown
}

export type LogTransactionBody = {
  happened_at?: unknown
  entries?: unknown
}

export type NormalizedTransactionEntry = {
  amount: string
  memo: string
  tags: string[]
}

export type NormalizedTransactionBatch = {
  happenedAt: Date
  entries: NormalizedTransactionEntry[]
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
    return { error: 'Invalid amount' }
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { error: 'Missing required field: amount' }
  }
  const check = validateDecimalString(trimmed)
  if ('error' in check) {
    // validateDecimalString 文案含 value_number；对外统一为 amount
    if (check.error === VALUE_NUMBER_MUST_BE_STRING) {
      return { error: AMOUNT_MUST_BE_STRING }
    }
    if (check.error === 'Invalid value_number') {
      return { error: 'Invalid amount' }
    }
    return { error: check.error }
  }
  return { ok: true, value: trimmed }
}

function parseSegment(
  raw: unknown,
  field: 'category' | 'subcategory',
): { ok: true; value: string } | DraftValidationError {
  if (typeof raw !== 'string' || raw === '') {
    return { error: `Missing required field: ${field}` }
  }
  if (/\s/.test(raw) || raw.includes(':') || !SEGMENT.test(raw)) {
    return {
      error: `Invalid ${field}: must be a single identifier without spaces or colons`,
    }
  }
  return { ok: true, value: raw }
}

function parseEntry(
  raw: unknown,
  index: number,
): NormalizedTransactionEntry | DraftValidationError {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `entries[${index}] must be an object` }
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

  return {
    amount: amountResult.value,
    memo: entry.memo,
    tags: [RESERVED_TAG_TRANSACTION_ENTRY, composite],
  }
}

/**
 * 解析 POST /api/log/transaction body。
 * entries 长度须在 1..MAX_TRANSACTION_ENTRIES；服务端组装保留 tag。
 */
export function parseTransactionBatch(
  body: LogTransactionBody,
): NormalizedTransactionBatch | DraftValidationError {
  const happenedResult = parseHappenedAt(body.happened_at)
  if ('error' in happenedResult) return happenedResult

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
    const parsed = parseEntry(body.entries[i], i)
    if ('error' in parsed) return parsed
    entries.push(parsed)
  }

  return {
    happenedAt: happenedResult.value,
    entries,
  }
}
