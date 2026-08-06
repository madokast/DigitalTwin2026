/**
 * createNumberBatch 批量事务回滚测试（继承项 2，Node 侧）：
 * 第 2 条 INSERT 注入错误 → uow.do 整体 reject → 500、无成功半状态（无 records 落回）。
 * 与 Go faas/internal/logapi/number_rollback_test.go 对齐。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertReturning = vi.fn().mockResolvedValue([
  {
    id: '01900000-0000-7000-8000-000000000099',
    happenedAt: new Date('2026-08-02T04:00:00.000Z'),
    utcOffset: '+08:00',
    numericValue: '42.5',
    rawContent: null,
    tags: '["num"]',
    objectiveContext: 'memo',
    aiAnalysis: null,
  },
])
const insertValues = vi.fn(() => ({ returning: insertReturning }))
const insert = vi.fn(() => ({ values: insertValues }))
const transaction = vi.fn(
  async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert }),
)

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/db', () => ({
  default: {
    transaction: (...args: unknown[]) =>
      transaction(args[0] as (tx: unknown) => Promise<unknown>),
  },
}))

import { createNumberBatch } from '@/lib/logapi'

const body = {
  happened_at: '2026-08-02T12:00:00+08:00',
  entries: [
    { numeric_value: '42.5', memo: 'first' },
    { numeric_value: '7.0', memo: 'second' },
  ],
}

beforeEach(() => {
  insert.mockClear()
  insertValues.mockClear()
  insertReturning.mockClear()
})

describe('createNumberBatch rollback (mocked db)', () => {
  it('returns 500 with no half-success when the 2nd insert fails', async () => {
    insertReturning
      .mockResolvedValueOnce([
        {
          id: 'a',
          happenedAt: new Date('2026-08-02T04:00:00.000Z'),
          utcOffset: '+08:00',
          numericValue: '42.5',
          rawContent: null,
          tags: '["num"]',
          objectiveContext: 'memo',
          aiAnalysis: null,
        },
      ])
      .mockRejectedValueOnce(new Error('injected insert failure'))

    const result = await createNumberBatch(body)
    expect(result).toEqual({ error: 'injected insert failure', status: 500 })
    expect(result).not.toHaveProperty('inserted')
    expect(result).not.toHaveProperty('records')
    expect(insert).toHaveBeenCalledTimes(2)
    expect(insertValues).toHaveBeenCalledTimes(2)
  })

  it('returns inserted records on success', async () => {
    const result = await createNumberBatch(body)
    expect(result.status).toBe(201)
    if ('records' in result) {
      expect(result.inserted).toBe(2)
      expect(result.records).toHaveLength(2)
    }
  })
})
