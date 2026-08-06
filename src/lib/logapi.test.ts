import { describe, expect, it } from 'vitest'
import { NUMERIC_VALUE_MUST_BE_STRING } from '@/lib/draft'
import {
  createNumberBatch,
  createText,
  createTransactionBatch,
} from '@/lib/logapi'
import { reservedTagError } from '@/lib/tags'
import { AMOUNT_MUST_BE_STRING, INVALID_AMOUNT } from '@/lib/transactiondraft'

/** 决策 D：业务函数失败 throw MyError（status + message）。 */
const rejects = async (
  p: Promise<unknown>,
  status: number,
  message: string,
) => {
  await expect(p).rejects.toMatchObject({ status, message })
}

describe('createText', () => {
  it('rejects whitespace-only raw_content', async () => {
    for (const raw of ['', '   ', '\t']) {
      await rejects(
        createText({
          happened_at: '2026-07-30T10:00:00Z',
          raw_content: raw,
          tags: ['study'],
          objective_context: 'x',
        }),
        400,
        raw === '' ? 'missing required field: raw_content' : 'raw_content must not be blank',
      )
    }
  })

  it('rejects happened_at without timezone', async () => {
    await rejects(
      createText({
        happened_at: '2026-07-30T10:00:00',
        raw_content: 'hello',
        tags: ['study'],
        objective_context: 'x',
      }),
      400,
      'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    )
  })

  it('rejects reserved tag', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'should fail',
        tags: ['transaction_entry'],
        objective_context: 'x',
      }),
      400,
      reservedTagError('transaction_entry'),
    )
  })

  it('rejects duplicate tags', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'dup',
        tags: ['study', 'study'],
        objective_context: 'x',
      }),
      400,
      'duplicate tag "study"',
    )
  })

  it('rejects todo reserved tag', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'should fail',
        tags: ['todo:in_progress'],
        objective_context: 'x',
      }),
      400,
      reservedTagError('todo:in_progress'),
    )
  })

  it('rejects non-string ai_analysis', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'hello',
        tags: ['study'],
        objective_context: 'x',
        ai_analysis: 42,
      }),
      400,
      'invalid ai_analysis',
    )
  })

  it('rejects non-string raw_content', async () => {
    await rejects(
      createText({
        happened_at: '2026-07-30T08:00:00Z',
        raw_content: 123,
        tags: ['study'],
        objective_context: 'x',
      }),
      400,
      'missing required field: raw_content',
    )
  })
})

describe('createTransactionBatch', () => {
  it('rejects empty entries', async () => {
    await rejects(
      createTransactionBatch({
        happened_at: '2026-08-01T12:30:00+08:00',
        type: 'expense',
        entries: [],
      }),
      400,
      'entries must be a non-empty array',
    )
  })

  it('rejects JSON number amount', async () => {
    await rejects(
      createTransactionBatch({
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
      }),
      400,
      expect.stringContaining(AMOUNT_MUST_BE_STRING),
    )
  })

  it('rejects missing type', async () => {
    await rejects(
      createTransactionBatch({
        happened_at: '2026-08-01T12:30:00+08:00',
        entries: [
          {
            amount: '25.00',
            memo: 'x',
            category: 'food',
            subcategory: 'lunch',
          },
        ],
      }),
      400,
      'missing required field: type',
    )
  })

  it('rejects zero amount', async () => {
    await rejects(
      createTransactionBatch({
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
      }),
      400,
      `entries[0]: ${INVALID_AMOUNT}`,
    )
  })
})

describe('createNumberBatch', () => {
  it('rejects empty entries', async () => {
    await rejects(
      createNumberBatch({
        happened_at: '2026-08-05T10:00:00+08:00',
        entries: [],
      }),
      400,
      'entries must be a non-empty array',
    )
  })

  it('rejects missing happened_at', async () => {
    await rejects(
      createNumberBatch({
        entries: [{ numeric_value: '1', memo: 'x' }],
      }),
      400,
      'missing required field: happened_at',
    )
  })

  it('rejects missing numeric_value with index prefix', async () => {
    await rejects(
      createNumberBatch({
        happened_at: '2026-08-05T10:00:00+08:00',
        entries: [{ memo: 'x' }],
      }),
      400,
      'entries[0]: missing required field: numeric_value',
    )
  })

  it('rejects JSON number numeric_value', async () => {
    await rejects(
      createNumberBatch({
        happened_at: '2026-08-05T10:00:00+08:00',
        entries: [{ numeric_value: 36.8, memo: 'x' }],
      }),
      400,
      expect.stringContaining(NUMERIC_VALUE_MUST_BE_STRING),
    )
  })

  it('rejects reserved tag with index prefix', async () => {
    await rejects(
      createNumberBatch({
        happened_at: '2026-08-05T10:00:00+08:00',
        entries: [{ numeric_value: '1', memo: 'x', tags: ['body:weight'] }],
      }),
      400,
      `entries[0]: ${reservedTagError('body:weight')}`,
    )
  })
})
