import { describe, expect, it } from 'vitest'
import { VALUE_NUMBER_MUST_BE_STRING } from '@/lib/draft'
import { createNumber, createText, createTransactionBatch } from '@/lib/logapi'
import { reservedTagError } from '@/lib/tags'
import { AMOUNT_MUST_BE_STRING, INVALID_AMOUNT } from '@/lib/transactiondraft'

describe('createNumber', () => {
  it('rejects happened_at without timezone', async () => {
    for (const happened of ['2026-07-30', '2026-07-30T08:00:00']) {
      const result = await createNumber({
        happened_at: happened,
        value_number: '1',
        tags: ['weight'],
        objective_context: 'x',
      })
      expect(result).toEqual({
        error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
        status: 400,
      })
    }
  })

  it('rejects JSON number value_number', async () => {
    const result = await createNumber({
      happened_at: '2026-07-30T08:00:00+08:00',
      value_number: 75.5,
      tags: ['weight'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: VALUE_NUMBER_MUST_BE_STRING,
      status: 400,
    })
  })

  it('rejects bad decimal strings', async () => {
    for (const bad of ['1e3', '1.', '+1']) {
      const result = await createNumber({
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: bad,
        tags: ['weight'],
        objective_context: 'x',
      })
      expect(result).toEqual({ error: 'Invalid value_number', status: 400 })
    }
  })

  it('rejects reserved tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      value_number: '1',
      tags: ['transaction_entry'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('transaction_entry'),
      status: 400,
    })
  })

  it('rejects reserved prefixed tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      value_number: '1',
      tags: ['transaction_entry:income'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('transaction_entry:income'),
      status: 400,
    })
  })

  it('rejects non-string subjective_interpretation', async () => {
    for (const bad of [1, true, [], {}]) {
      const result = await createNumber({
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '1',
        tags: ['weight'],
        objective_context: 'x',
        subjective_interpretation: bad,
      })
      expect(result).toEqual({
        error: 'Invalid subjective_interpretation',
        status: 400,
      })
    }
  })

  it('rejects wrong JSON field types with field-level messages', async () => {
    expect(
      await createNumber({
        happened_at: 123,
        value_number: '1',
        tags: ['weight'],
        objective_context: 'x',
      }),
    ).toEqual({ error: 'Missing required field: happened_at', status: 400 })
    expect(
      await createNumber({
        happened_at: '2026-07-30T08:00:00Z',
        value_number: '1',
        tags: 'x',
        objective_context: 'x',
      }),
    ).toEqual({
      error: 'Missing required field: tags (non-empty array)',
      status: 400,
    })
    expect(
      await createNumber({
        happened_at: '2026-07-30T08:00:00Z',
        value_number: '1',
        tags: ['weight'],
        objective_context: 123,
      }),
    ).toEqual({
      error: 'Missing required field: objective_context',
      status: 400,
    })
  })
})

describe('createText', () => {
  it('rejects happened_at without timezone', async () => {
    const result = await createText({
      happened_at: '2026-07-30T10:00:00',
      value_text: 'hello',
      tags: ['study'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
      status: 400,
    })
  })

  it('rejects reserved tag', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      value_text: 'should fail',
      tags: ['transaction_entry'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('transaction_entry'),
      status: 400,
    })
  })

  it('rejects non-string subjective_interpretation', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      value_text: 'hello',
      tags: ['study'],
      objective_context: 'x',
      subjective_interpretation: 42,
    })
    expect(result).toEqual({
      error: 'Invalid subjective_interpretation',
      status: 400,
    })
  })

  it('rejects non-string value_text', async () => {
    expect(
      await createText({
        happened_at: '2026-07-30T08:00:00Z',
        value_text: 123,
        tags: ['study'],
        objective_context: 'x',
      }),
    ).toEqual({ error: 'Missing required field: value_text', status: 400 })
  })
})

describe('createTransactionBatch', () => {
  it('rejects empty entries', async () => {
    const result = await createTransactionBatch({
      happened_at: '2026-08-01T12:30:00+08:00',
      type: 'expense',
      entries: [],
    })
    expect(result).toEqual({
      error: 'entries must be a non-empty array',
      status: 400,
    })
  })

  it('rejects JSON number amount', async () => {
    const result = await createTransactionBatch({
      happened_at: '2026-08-01T12:30:00+08:00',
      type: 'expense',
      entries: [
        {
          amount: 25,
          memo: 'x',
          category: 'food',
          subcategory: 'lunch',
        },
      ],
    })
    expect(result.status).toBe(400)
    expect('error' in result && result.error).toContain(AMOUNT_MUST_BE_STRING)
  })

  it('rejects missing type', async () => {
    const result = await createTransactionBatch({
      happened_at: '2026-08-01T12:30:00+08:00',
      entries: [
        {
          amount: '25.00',
          memo: 'x',
          category: 'food',
          subcategory: 'lunch',
        },
      ],
    })
    expect(result).toEqual({
      error: 'Missing required field: type',
      status: 400,
    })
  })

  it('rejects zero amount', async () => {
    const result = await createTransactionBatch({
      happened_at: '2026-08-01T12:30:00+08:00',
      type: 'income',
      entries: [
        {
          amount: '0.00',
          memo: 'x',
          category: 'food',
          subcategory: 'lunch',
        },
      ],
    })
    expect(result).toEqual({
      error: `entries[0]: ${INVALID_AMOUNT}`,
      status: 400,
    })
  })
})
