import { describe, expect, it } from 'vitest'
import { NUMERIC_VALUE_MUST_BE_STRING } from '@/lib/draft'
import { INVALID_WEIGHT } from '@/lib/bodyweightdraft'
import {
  createBodyWeight,
  createNumberBatch,
  createText,
  createTodo,
  transitionTodo,
  createTransactionBatch,
} from '@/lib/logapi'
import { INVALID_RECORD_ID } from '@/lib/record'
import { reservedTagError } from '@/lib/tags'
import { ERR_INVALID_TARGET } from '@/lib/tododraft'
import { AMOUNT_MUST_BE_STRING, INVALID_AMOUNT } from '@/lib/transactiondraft'

describe('createText', () => {
  it('rejects whitespace-only raw_content', async () => {
    for (const raw of ['', '   ', '\t']) {
      const result = await createText({
        happened_at: '2026-07-30T10:00:00Z',
        raw_content: raw,
        tags: ['study'],
        objective_context: 'x',
      })
      expect(result).toEqual({
        error:
          raw === '' ? 'Missing required field: raw_content' : 'raw_content must not be blank',
        status: 400,
      })
    }
  })

  it('rejects happened_at without timezone', async () => {
    const result = await createText({
      happened_at: '2026-07-30T10:00:00',
      raw_content: 'hello',
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
      raw_content: 'should fail',
      tags: ['transaction_entry'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('transaction_entry'),
      status: 400,
    })
  })

  it('rejects duplicate tags', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      raw_content: 'dup',
      tags: ['study', 'study'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: 'Duplicate tag "study"',
      status: 400,
    })
  })

  it('rejects todo reserved tag', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      raw_content: 'should fail',
      tags: ['todo:in_progress'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('todo:in_progress'),
      status: 400,
    })
  })

  it('rejects non-string ai_analysis', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      raw_content: 'hello',
      tags: ['study'],
      objective_context: 'x',
      ai_analysis: 42,
    })
    expect(result).toEqual({
      error: 'Invalid ai_analysis',
      status: 400,
    })
  })

  it('rejects non-string raw_content', async () => {
    expect(
      await createText({
        happened_at: '2026-07-30T08:00:00Z',
        raw_content: 123,
        tags: ['study'],
        objective_context: 'x',
      }),
    ).toEqual({ error: 'Missing required field: raw_content', status: 400 })
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

describe('createNumberBatch', () => {
  it('rejects empty entries', async () => {
    const result = await createNumberBatch({
      happened_at: '2026-08-05T10:00:00+08:00',
      entries: [],
    })
    expect(result).toEqual({
      error: 'entries must be a non-empty array',
      status: 400,
    })
  })

  it('rejects missing happened_at', async () => {
    const result = await createNumberBatch({
      entries: [{ numeric_value: '1', memo: 'x' }],
    })
    expect(result).toEqual({
      error: 'Missing required field: happened_at',
      status: 400,
    })
  })

  it('rejects missing numeric_value with index prefix', async () => {
    const result = await createNumberBatch({
      happened_at: '2026-08-05T10:00:00+08:00',
      entries: [{ memo: 'x' }],
    })
    expect(result).toEqual({
      error: 'entries[0]: Missing required field: numeric_value',
      status: 400,
    })
  })

  it('rejects JSON number numeric_value', async () => {
    const result = await createNumberBatch({
      happened_at: '2026-08-05T10:00:00+08:00',
      entries: [{ numeric_value: 36.8, memo: 'x' }],
    })
    expect(result.status).toBe(400)
    expect('error' in result && result.error).toContain(NUMERIC_VALUE_MUST_BE_STRING)
  })

  it('rejects reserved tag with index prefix', async () => {
    const result = await createNumberBatch({
      happened_at: '2026-08-05T10:00:00+08:00',
      entries: [{ numeric_value: '1', memo: 'x', tags: ['body:weight'] }],
    })
    expect(result).toEqual({
      error: `entries[0]: ${reservedTagError('body:weight')}`,
      status: 400,
    })
  })
})
