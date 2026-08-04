import { describe, expect, it, vi } from 'vitest'
import { VALUE_NUMBER_MUST_BE_STRING } from '@/lib/draft'
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

// D7 竞态测试：mock db 层（vi.mock 提升，须 hoisted）
const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock('@/db', () => ({ default: mockDb }))
vi.mock('@/db/schema', () => ({ records: {} }))
import { reservedTagError } from '@/lib/tags'
import { ERR_INVALID_TARGET } from '@/lib/tododraft'
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

  it('rejects body:weight reserved tag', async () => {
    const result = await createNumber({
      happened_at: '2026-08-01T12:30:00+08:00',
      value_number: '1',
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
      value_number: '1',
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
      value_number: '1',
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

describe('createBodyWeight', () => {
  it('rejects JSON number value_number', async () => {
    const result = await createBodyWeight({
      happened_at: '2026-08-02T08:00:00+08:00',
      value_number: 75.5,
      objective_context: 'x',
    })
    expect(result).toEqual({
      error: VALUE_NUMBER_MUST_BE_STRING,
      status: 400,
    })
  })

  it('rejects out-of-range and bad shape with INVALID_WEIGHT', async () => {
    for (const bad of ['0', '500.01', '75.123', ' 75']) {
      const result = await createBodyWeight({
        happened_at: '2026-08-02T08:00:00+08:00',
        value_number: bad,
        objective_context: 'x',
      })
      expect(result).toEqual({ error: INVALID_WEIGHT, status: 400 })
    }
  })

  it('rejects reserved client tags', async () => {
    const result = await createBodyWeight({
      happened_at: '2026-08-02T08:00:00+08:00',
      value_number: '75',
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

describe('transitionTodo race on UPDATE affected rows (D7)', () => {
  const TODO_ID = '01900000-0000-7000-8000-000000000001'
  const row = {
    id: TODO_ID,
    happenedAt: new Date('2026-08-02T04:00:00Z'),
    utcOffset: '+08:00',
    valueNumber: null,
    valueText: 'buy milk',
    tags: '["todo:in_progress"]',
    objectiveContext: 'grocery',
    subjectiveInterpretation: null,
  }
  const body = {
    id: TODO_ID,
    target: 'completed',
    happened_at: '2026-08-02T12:00:00+08:00',
  }

  function installMockDb(affected: number) {
    const insert = vi.fn(async () => [])
    const tx = {
      update: () => ({
        set: () => ({ where: async () => ({ count: affected }) }),
      }),
      insert: () => ({ values: insert }),
    }
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [row] }) }),
    }))
    mockDb.transaction.mockImplementation(
      async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    )
    return insert
  }

  it('affected 0 → 500 with Go-matching message, no audit insert', async () => {
    const insert = installMockDb(0)
    await expect(transitionTodo(body)).resolves.toEqual({
      error: 'todo update affected 0 rows',
      status: 500,
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it('affected 1 → 200 success and audit inserted', async () => {
    const insert = installMockDb(1)
    const result = await transitionTodo(body)
    expect(result.status).toBe(200)
    expect(insert).toHaveBeenCalledTimes(1)
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

  it('rejects todo reserved tag', async () => {
    const result = await createText({
      happened_at: '2026-08-01T12:30:00+08:00',
      value_text: 'should fail',
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
