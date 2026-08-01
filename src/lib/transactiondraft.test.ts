import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AMOUNT_MUST_BE_STRING,
  INVALID_AMOUNT,
  MAX_TRANSACTION_ENTRIES,
  normalizeMoneyAmount2,
  parseTransactionBatch,
} from './transactiondraft'

const moneyCases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/money-amount-cases.json',
    ),
    'utf8',
  ),
) as {
  invalidAmountError: string
  accept: { input: string; stored: string }[]
  reject: { input: string; error: string }[]
}

describe('parseTransactionBatch', () => {
  const base = {
    happened_at: '2026-08-01T12:30:00+08:00',
    type: 'expense' as const,
    entries: [
      {
        amount: '25.00',
        memo: 'beef noodle',
        category: 'food',
        subcategory: 'lunch',
      },
    ],
  }

  it('accepts a single-entry expense batch', () => {
    const parsed = parseTransactionBatch(base)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.type).toBe('expense')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toEqual({
      amount: '25.00',
      memo: 'beef noodle',
      tags: ['transaction_entry:expense', 'food:lunch'],
    })
  })

  it('accepts income type and negative amount (reversal)', () => {
    const parsed = parseTransactionBatch({
      ...base,
      type: 'income',
      entries: [{ ...base.entries[0], amount: '-10.00', memo: 'refund' }],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.type).toBe('income')
    expect(parsed.entries[0].tags).toEqual([
      'transaction_entry:income',
      'food:lunch',
    ])
    expect(parsed.entries[0].amount).toBe('-10.00')
  })

  it('rejects missing or invalid type', () => {
    expect(
      parseTransactionBatch({
        happened_at: base.happened_at,
        entries: base.entries,
      }),
    ).toEqual({ error: 'Missing required field: type' })

    expect(
      parseTransactionBatch({
        ...base,
        type: 'transfer',
      }),
    ).toEqual({ error: 'type must be "income" or "expense"' })
  })

  it('shared money-amount accept fixtures (normalized stored)', () => {
    expect(moneyCases.invalidAmountError).toBe(INVALID_AMOUNT)
    for (const { input, stored } of moneyCases.accept) {
      const parsed = parseTransactionBatch({
        ...base,
        entries: [{ ...base.entries[0], amount: input }],
      })
      expect('error' in parsed, input).toBe(false)
      if ('error' in parsed) return
      expect(parsed.entries[0].amount, input).toBe(stored)
    }
  })

  it('shared money-amount reject fixtures (byte-identical error)', () => {
    for (const { input, error } of moneyCases.reject) {
      const parsed = parseTransactionBatch({
        ...base,
        entries: [{ ...base.entries[0], amount: input }],
      })
      expect(parsed, JSON.stringify(input)).toEqual({
        error: `entries[0]: ${error}`,
      })
    }
  })

  it('normalizeMoneyAmount2 pads to two fractional digits', () => {
    expect(normalizeMoneyAmount2('10')).toBe('10.00')
    expect(normalizeMoneyAmount2('10.5')).toBe('10.50')
    expect(normalizeMoneyAmount2('-1.5')).toBe('-1.50')
  })

  it('rejects empty entries', () => {
    const parsed = parseTransactionBatch({
      happened_at: base.happened_at,
      type: 'expense',
      entries: [],
    })
    expect(parsed).toEqual({ error: 'entries must be a non-empty array' })
  })

  it('rejects amount as JSON number', () => {
    const parsed = parseTransactionBatch({
      happened_at: base.happened_at,
      type: 'expense',
      entries: [{ ...base.entries[0], amount: 25 }],
    })
    expect(parsed).toEqual({
      error: `entries[0]: ${AMOUNT_MUST_BE_STRING}`,
    })
  })

  it('rejects missing amount field', () => {
    const { amount: _omit, ...rest } = base.entries[0]
    const parsed = parseTransactionBatch({
      ...base,
      entries: [rest],
    })
    expect(parsed).toEqual({
      error: 'entries[0]: Missing required field: amount',
    })
  })

  it('rejects category with colon, ASCII space, or NBSP', () => {
    const withColon = parseTransactionBatch({
      ...base,
      entries: [{ ...base.entries[0], category: 'food:x' }],
    })
    expect('error' in withColon).toBe(true)

    const withSpace = parseTransactionBatch({
      ...base,
      entries: [{ ...base.entries[0], category: 'food x' }],
    })
    expect('error' in withSpace).toBe(true)

    // \u00a0：两端均拒（SEGMENT ASCII）；空白集合本身已与 Go 对齐为 [ \\t\\n\\r]
    const withNbsp = parseTransactionBatch({
      ...base,
      entries: [{ ...base.entries[0], category: 'food\u00a0x' }],
    })
    expect('error' in withNbsp).toBe(true)
  })

  it(`rejects more than ${MAX_TRANSACTION_ENTRIES} entries`, () => {
    const entries = Array.from({ length: MAX_TRANSACTION_ENTRIES + 1 }, () => ({
      ...base.entries[0],
    }))
    const parsed = parseTransactionBatch({
      happened_at: base.happened_at,
      type: 'expense',
      entries,
    })
    expect(parsed).toEqual({
      error: `entries must contain at most ${MAX_TRANSACTION_ENTRIES} items`,
    })
  })

  it('rejects wrong JSON field types with field-level messages', () => {
    expect(
      parseTransactionBatch({
        ...base,
        type: 123,
      }),
    ).toEqual({ error: 'type must be "income" or "expense"' })
    expect(
      parseTransactionBatch({
        ...base,
        entries: 'x' as unknown as typeof base.entries,
      }),
    ).toEqual({
      error: 'Missing required field: entries (non-empty array)',
    })
  })
})
