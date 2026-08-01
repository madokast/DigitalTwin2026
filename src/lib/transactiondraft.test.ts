import { describe, expect, it } from 'vitest'
import {
  AMOUNT_MUST_BE_STRING,
  AMOUNT_MUST_NOT_BE_ZERO,
  MAX_TRANSACTION_ENTRIES,
  parseTransactionBatch,
} from './transactiondraft'

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

  it('rejects zero amount after decimal validate', () => {
    for (const amount of ['0', '0.0', '0.00', '-0', '-0.00']) {
      const parsed = parseTransactionBatch({
        ...base,
        entries: [{ ...base.entries[0], amount }],
      })
      expect(parsed).toEqual({
        error: `entries[0]: ${AMOUNT_MUST_NOT_BE_ZERO}`,
      })
    }
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

  it('rejects category with colon or space', () => {
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
})
