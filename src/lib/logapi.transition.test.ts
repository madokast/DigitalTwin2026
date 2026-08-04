/**
 * transitionTodo 域错误 / 成功路径：mock Drizzle，无需真实 DATABASE_URL。
 * 与 Go faas/internal/logapi/todo_db_test.go 对齐。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const limit = vi.fn()
const where = vi.fn(() => ({ limit }))
const from = vi.fn(() => ({ where }))
const select = vi.fn(() => ({ from }))

const txWhere = vi.fn().mockResolvedValue({ count: 1 })
const txSet = vi.fn(() => ({ where: txWhere }))
const txUpdate = vi.fn(() => ({ set: txSet }))
const txValues = vi.fn().mockResolvedValue(undefined)
const txInsert = vi.fn(() => ({ values: txValues }))
const transaction = vi.fn(
  async (fn: (tx: { update: typeof txUpdate; insert: typeof txInsert }) => Promise<void>) =>
    fn({ update: txUpdate, insert: txInsert }),
)

vi.mock('@/db', () => ({
  default: {
    select: (...args: unknown[]) => select(...args),
    transaction: (...args: unknown[]) => transaction(...args),
  },
}))

import { transitionTodo } from '@/lib/logapi'
import {
  ERR_ALREADY_TARGET,
  ERR_AUDIT_TRANSITION,
  ERR_NOT_A_TODO,
  ERR_TODO_NOT_FOUND,
  auditValueText,
} from '@/lib/tododraft'

const todoId = '01900000-0000-7000-8000-000000000003'
const body = {
  id: todoId,
  target: 'completed' as const,
  happened_at: '2026-08-02T12:00:00+08:00',
}

function todoRow(tags: string, valueText = 'Buy milk') {
  return {
    id: todoId,
    happenedAt: new Date('2026-08-02T02:00:00.000Z'),
    utcOffset: 'Z',
    valueNumber: null,
    valueText,
    tags,
    objectiveContext: 'weekend grocery list',
    subjectiveInterpretation: null,
  }
}

beforeEach(() => {
  select.mockClear()
  from.mockClear()
  where.mockClear()
  limit.mockReset()
  transaction.mockClear()
  txUpdate.mockClear()
  txSet.mockClear()
  txWhere.mockClear()
  txInsert.mockClear()
  txValues.mockClear()
})

describe('transitionTodo domain errors (mocked db)', () => {
  it('returns to-do not found when row missing', async () => {
    limit.mockResolvedValueOnce([])
    await expect(transitionTodo(body)).resolves.toEqual({
      error: ERR_TODO_NOT_FOUND,
      status: 404,
    })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns record is not a to-do for plain text row', async () => {
    limit.mockResolvedValueOnce([todoRow(JSON.stringify(['note']), 'plain note')])
    await expect(transitionTodo(body)).resolves.toEqual({
      error: ERR_NOT_A_TODO,
      status: 400,
    })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns cannot transition a to-do audit record', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:transition']), 'Complete a to-do created at x: y'),
    ])
    await expect(transitionTodo(body)).resolves.toEqual({
      error: ERR_AUDIT_TRANSITION,
      status: 400,
    })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns to-do is already in target state', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:completed', 'errand'])),
    ])
    await expect(transitionTodo(body)).resolves.toEqual({
      error: ERR_ALREADY_TARGET,
      status: 400,
    })
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('transitionTodo success (mocked db)', () => {
  it('returns from/to TodoState and auditValueText; runs transaction', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:in_progress', 'errand'])),
    ])
    const wantAudit = auditValueText(
      'completed',
      '2026-08-02T02:00:00.000Z',
      'Buy milk',
    )
    const result = await transitionTodo(body)
    expect(result).toEqual({
      id: todoId,
      from: 'in_progress',
      to: 'completed',
      auditValueText: wantAudit,
      status: 200,
    })
    expect(result).not.toHaveProperty('record')
    expect(result).not.toHaveProperty('audit_record')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txUpdate).toHaveBeenCalled()
    expect(txInsert).toHaveBeenCalled()
    expect(txValues).toHaveBeenCalledWith(
      expect.objectContaining({
        valueText: wantAudit,
        tags: JSON.stringify(['todo:transition']),
        objectiveContext: `The index of the to-do is ${todoId}`,
      }),
    )
  })
})

describe('transitionTodo mid-transaction failure (mocked db)', () => {
  // UPDATE 成功、审计 INSERT 失败 → transaction 抛错，无成功半状态。
  it('aborts when INSERT fails after UPDATE; no success result', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:in_progress', 'errand'])),
    ])
    txValues.mockRejectedValueOnce(new Error('audit insert failed'))

    const result = await transitionTodo(body)
    expect(result).toEqual({
      error: 'Internal server error',
      status: 500,
    })
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('from')
    expect(result).not.toHaveProperty('auditValueText')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txUpdate).toHaveBeenCalled()
    expect(txSet).toHaveBeenCalled()
    expect(txWhere).toHaveBeenCalled()
    expect(txInsert).toHaveBeenCalled()
    expect(txValues).toHaveBeenCalled()
    await expect(transaction.mock.results[0]?.value).rejects.toThrow(
      'audit insert failed',
    )
  })
})

describe('transitionTodo UPDATE affected rows race (D7)', () => {
  // SELECT 与 UPDATE 之间记录被删 → Go 同款 500 + 文案，不插审计行（对齐 todo.go RowsAffected）。
  it('affected 0 → 500 todo update affected 0 rows; no audit insert', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:in_progress', 'errand'])),
    ])
    txWhere.mockResolvedValueOnce({ count: 0 })

    await expect(transitionTodo(body)).resolves.toEqual({
      error: 'todo update affected 0 rows',
      status: 500,
    })
    expect(txUpdate).toHaveBeenCalled()
    expect(txInsert).not.toHaveBeenCalled()
  })
})
