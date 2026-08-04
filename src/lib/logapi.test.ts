import { describe, expect, it } from 'vitest'
import { NUMERIC_VALUE_MUST_BE_STRING } from '@/lib/draft'
import { INVALID_WEIGHT } from '@/lib/bodyweightdraft'
import {
  createBodyWeight,
  createNumber,
  createText,
  createTodo,
  transitionTodo,
  createTransactionBatch,
} from '@/lib/logapi'
import { INVALID_RECORD_ID } from '@/lib/record'
import { reservedTagError } from '@/lib/tags'
import { ERR_INVALID_TARGET } from '@/lib/tododraft'
import { AMOUNT_MUST_BE_STRING, INVALID_AMOUNT } from '@/lib/transactiondraft'

describe('createNumber', () => {
  it('rejects happened_at without timezone', async () => {
    for (const happened of ['2026-07-30', '2026-07-30T08:00:00']) {
      const result = await createNumber({
        happened_at: happened,
        numeric_value: '1',
        tags: ['weight'],
        objective_context: 'x',
      })
      expect(result).toEqual({
        error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
        status: 400,
      })
    }
  })

  it('rejects JSON number numeric_value', async () => {
    const result = await createNumber({
      happened_at: '2026-07-30T08:00:00+08:00',
      numeric_value: 75.5,
      tags: ['weight'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: NUMERIC_VALUE_MUST_BE_STRING,
      status: 400,
    })
  })

  it('rejects bad decimal strings', async () => {
    for (const bad of ['1e3', '1.', '+1']) {
      const result = await createNumber({
        happened_at: '2026-07-30T08:00:00+08:00',
        numeric_value: bad,
        tags: ['weight'],
        objective_context: 'x',
      })
      expect(result).toEqual({ error: 'Invalid numeric_value', status: 400 })
    }
  })

  it('rejects reserved tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      numeric_value: '1',
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
      numeric_value: '1',
      tags: ['transaction_entry:income'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('transaction_entry:income'),
      status: 400,
    })
  })

  it('rejects body:weight reserved tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      numeric_value: '1',
      tags: ['body:weight'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('body:weight'),
      status: 400,
    })
  })

  it('rejects todo reserved tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      numeric_value: '1',
      tags: ['todo'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('todo'),
      status: 400,
    })
  })

  it('rejects todo:in_progress reserved tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      numeric_value: '1',
      tags: ['todo:in_progress'],
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: reservedTagError('todo:in_progress'),
      status: 400,
    })
  })

  it('rejects non-string subjective_interpretation', async () => {
    for (const bad of [1, true, [], {}]) {
      const result = await createNumber({
        happened_at: '2026-07-30T08:00:00+08:00',
        numeric_value: '1',
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
        numeric_value: '1',
        tags: ['weight'],
        objective_context: 'x',
      }),
    ).toEqual({ error: 'Missing required field: happened_at', status: 400 })
    expect(
      await createNumber({
        happened_at: '2026-07-30T08:00:00Z',
        numeric_value: '1',
        tags: 'x',
        objective_context: 'x',
      }),
    ).toEqual({
      error: 'tags must be an array of strings',
      status: 400,
    })
    expect(
      await createNumber({
        happened_at: '2026-07-30T08:00:00Z',
        numeric_value: '1',
        tags: ['weight'],
        objective_context: 123,
      }),
    ).toEqual({
      error: 'Missing required field: objective_context',
      status: 400,
    })
  })
})

describe('createBodyWeight', () => {
  it('rejects JSON number numeric_value', async () => {
    const result = await createBodyWeight({
      happened_at: '2026-08-02T08:00:00+08:00',
      numeric_value: 75.5,
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: NUMERIC_VALUE_MUST_BE_STRING,
      status: 400,
    })
  })

  it('rejects out-of-range and bad shape with INVALID_WEIGHT', async () => {
    for (const bad of ['0', '500.01', '75.123', ' 75']) {
      const result = await createBodyWeight({
        happened_at: '2026-08-02T08:00:00+08:00',
        numeric_value: bad,
        objective_context: 'x',
      })
      expect(result).toEqual({ error: INVALID_WEIGHT, status: 400 })
    }
  })

  it('rejects reserved client tags', async () => {
    const result = await createBodyWeight({
      happened_at: '2026-08-02T08:00:00+08:00',
      numeric_value: '75',
      objective_context: 'x',
      tags: ['body:weight'],
    })
    expect(result).toEqual({
      error: reservedTagError('body:weight'),
      status: 400,
    })
  })
})

describe('createTodo', () => {
  it('rejects missing created_at and reserved tags', async () => {
    const missing = await createTodo({
      content: 'Buy milk',
      objective_context: 'x',
    })
    expect(missing).toEqual({
      error: 'Missing required field: created_at',
      status: 400,
    })

    const reserved = await createTodo({
      created_at: '2026-08-02T10:00:00+08:00',
      content: 'Buy milk',
      objective_context: 'x',
      tags: ['todo:in_progress'],
    })
    expect(reserved).toEqual({
      error: reservedTagError('todo:in_progress'),
      status: 400,
    })
  })

  it('rejects happened_at alias key', async () => {
    const result = await createTodo({
      created_at: '2026-08-02T10:00:00+08:00',
      happened_at: '2026-08-02T10:00:00+08:00',
      content: 'Buy milk',
      objective_context: 'x',
    } as Parameters<typeof createTodo>[0] & { happened_at: string })
    expect(result).toEqual({
      error: 'Unknown JSON key: happened_at',
      status: 400,
    })
  })
})

describe('transitionTodo', () => {
  it('rejects missing id / invalid target / invalid uuid without DB', async () => {
    expect(
      await transitionTodo({
        target: 'completed',
        happened_at: '2026-08-02T12:00:00+08:00',
      }),
    ).toEqual({ error: 'Missing required field: id', status: 400 })

    expect(
      await transitionTodo({
        id: '01900000-0000-7000-8000-000000000003',
        target: 'done',
        happened_at: '2026-08-02T12:00:00+08:00',
      }),
    ).toEqual({ error: ERR_INVALID_TARGET, status: 400 })

    expect(
      await transitionTodo({
        id: 'not-a-uuid',
        target: 'completed',
        happened_at: '2026-08-02T12:00:00+08:00',
      }),
    ).toEqual({ error: INVALID_RECORD_ID, status: 400 })
  })
})

describe('createText', () => {
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

  it('rejects non-string subjective_interpretation', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      raw_content: 'hello',
      tags: ['study'],
      objective_context: 'x',
      subjective_interpretation: 42,
    })
    expect(result).toEqual({
      error: 'Invalid subjective_interpretation',
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
