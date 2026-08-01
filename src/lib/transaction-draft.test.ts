import { describe, expect, it } from 'vitest'
import {
  AMOUNT_MUST_BE_STRING,
  MAX_TRANSACTION_ENTRIES,
  parseTransactionBatch,
} from './transaction-draft'

describe('parseTransactionBatch', () => {
  const base = {
    happened_at: '2026-08-01T12:30:00+08:00',
    entries: [
      {
        amount: '25.00',
        memo: 'beef noodle',
        category: 'food',
        subcategory: 'lunch',
      },
    ],
  }

  it('accepts a single-entry batch', () => {
    const parsed = parseTransactionBatch(base)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toEqual({
      amount: '25.00',
      memo: 'beef noodle',
      tags: ['transaction_entry', 'food:lunch'],
    })
  })

  it('rejects empty entries', () => {
    const parsed = parseTransactionBatch({
      happened_at: base.happened_at,
      entries: [],
    })
    expect(parsed).toEqual({ error: 'entries must be a non-empty array' })
  })

  it('rejects amount as JSON number', () => {
    const parsed = parseTransactionBatch({
      happened_at: base.happened_at,
      entries: [{ ...base.entries[0], amount: 25 }],
    })
    expect(parsed).toEqual({
      error: `entries[0]: ${AMOUNT_MUST_BE_STRING}`,
    })
  })

  it('rejects category with colon or space', () => {
    const withColon = parseTransactionBatch({
      happened_at: base.happened_at,
      entries: [{ ...base.entries[0], category: 'food:x' }],
    })
    expect('error' in withColon).toBe(true)

    const withSpace = parseTransactionBatch({
      happened_at: base.happened_at,
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
      entries,
    })
    expect(parsed).toEqual({
      error: `entries must contain at most ${MAX_TRANSACTION_ENTRIES} items`,
    })
  })
})
