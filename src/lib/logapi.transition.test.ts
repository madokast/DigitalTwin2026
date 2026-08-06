/**
 * transitionTodo 域错误 / 成功路径：mock Drizzle，无需真实 DATABASE_URL。
 * 与 Go faas/internal/logapi/todo_db_test.go 对齐。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const limit = vi.fn()
const where = vi.fn(() => ({ limit }))
const from = vi.fn(() => ({ where }))
const select = vi.fn<(...args: unknown[]) => { from: typeof from }>(
  () => ({ from }),
)

const txWhere = vi.fn().mockResolvedValue({ count: 1 })
const txSet = vi.fn(() => ({ where: txWhere }))
const txUpdate = vi.fn(() => ({ set: txSet }))
const txReturning = vi.fn().mockResolvedValue([
  {
    id: '01900000-0000-7000-8000-000000000099',
    happenedAt: new Date('2026-08-02T04:00:00.000Z'),
    utcOffset: '+08:00',
    numericValue: null,
    rawContent: 'Buy milk',
    tags: JSON.stringify(['todo:transition']),
    objectiveContext: 'todo transition: 01900000-0000-7000-8000-000000000003 to completed (2026-08-02T04:00:00.000+08:00)',
    aiAnalysis: null,
  },
])
const txValues = vi.fn(() => ({ returning: txReturning }))
const txInsert = vi.fn(() => ({ values: txValues }))
const transaction = vi.fn(
  async (...args: unknown[]) =>
    (args[0] as (tx: { update: typeof txUpdate; insert: typeof txInsert }) => Promise<void>)({
      update: txUpdate,
      insert: txInsert,
    }),
)

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/db', () => ({
  default: {
    select: (...args: unknown[]) => select(...args),
    transaction: (...args: unknown[]) => transaction(...args),
  },
}))

import { transitionTodo } from '@/lib/logapi'
import {
  auditObjectiveContext,
  todoAuditNotifyText,
  ERR_ALREADY_TARGET,
  ERR_AUDIT_TRANSITION,
  ERR_NOT_A_TODO,
  ERR_TODO_NOT_FOUND,
} from '@/lib/tododraft'

const todoId = '01900000-0000-7000-8000-000000000003'
const body = {
  id: todoId,
  target: 'completed' as const,
  happened_at: '2026-08-02T12:00:00+08:00',
}

function todoRow(tags: string, rawContent = 'Buy milk') {
  return {
    id: todoId,
    happenedAt: new Date('2026-08-02T02:00:00.000Z'),
    utcOffset: 'Z',
    numericValue: null,
    rawContent,
    tags,
    objectiveContext: 'weekend grocery list',
    aiAnalysis: null,
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
  txReturning.mockClear()
})

describe('transitionTodo domain errors (mocked db)', () => {
  it('returns to-do not found when row missing', async () => {
    limit.mockResolvedValueOnce([])
    await expect(transitionTodo(body)).rejects.toMatchObject({ status: 404, message: ERR_TODO_NOT_FOUND })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns record is not a to-do for plain text row', async () => {
    limit.mockResolvedValueOnce([todoRow(JSON.stringify(['note']), 'plain note')])
    await expect(transitionTodo(body)).rejects.toMatchObject({ status: 400, message: ERR_NOT_A_TODO })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns cannot transition a to-do audit record', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:transition']), 'Buy milk'),
    ])
    await expect(transitionTodo(body)).rejects.toMatchObject({ status: 400, message: ERR_AUDIT_TRANSITION })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('returns to-do is already in target state', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:completed', 'errand'])),
    ])
    await expect(transitionTodo(body)).rejects.toMatchObject({ status: 400, message: ERR_ALREADY_TARGET })
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('transitionTodo success (mocked db)', () => {
  it('inserts audit row exactly and returns notify text', async () => {
    limit.mockResolvedValueOnce([
      todoRow(JSON.stringify(['todo:in_progress', 'errand'])),
    ])
    const wantNotify = todoAuditNotifyText(
      'completed',
      todoId,
      '2026-08-02T02:00:00.000Z',
      'Buy milk',
    )
    const wantObjCtx = auditObjectiveContext(
      'completed',
      todoId,
      '2026-08-02T02:00:00.000Z',
    )
    const result = await transitionTodo(body)
    expect(result).toEqual({
      id: todoId,
      from: 'in_progress',
      to: 'completed',
      todoAuditNotifyText: wantNotify,
    })
    expect(result).not.toHaveProperty('record')
    expect(result).not.toHaveProperty('audit_record')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txUpdate).toHaveBeenCalled()
    expect(txInsert).toHaveBeenCalled()
    expect(txValues).toHaveBeenCalledWith(
      expect.objectContaining({
        numericValue: null,
        rawContent: 'Buy milk', // 审计行 = 待办原文逐字拷贝
        tags: JSON.stringify(['todo:transition']),
        objectiveContext: wantObjCtx,
        aiAnalysis: null,
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
    txReturning.mockRejectedValueOnce(new Error('audit insert failed'))

    await expect(transitionTodo(body)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('audit insert failed'),
    })
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

    await expect(transitionTodo(body)).rejects.toMatchObject({ status: 500, message: expect.stringContaining('todo update affected 0 rows') })
    expect(txUpdate).toHaveBeenCalled()
    expect(txInsert).not.toHaveBeenCalled()
  })
})
