/**
 * recordrepo.findByCriteria：mock Drizzle builder 链，无需真实 DATABASE_URL。
 * 与 Go faas/internal/recordrepo/repository_test.go 对齐。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const offset = vi.fn()
const limit = vi.fn(() => ({ offset }))
// id 路径在 orderBy 处 await（thenable 交付行）；分页路径继续 .limit().offset()
const orderBy = vi.fn(() => ({
  limit,
  then: (resolve: (v: unknown) => void) => resolve(ROWS),
}))
const where = vi.fn(() => ({ orderBy }))
const from = vi.fn(() => ({ where, orderBy }))
const select = vi.fn(() => ({ from }))

// findByCriteria 直接收执行器 q（无 db 顶层 import）；q 即 mock builder 链。
const q = { select } as unknown as Executor

import type { Executor } from '@/db/uow'
import { Repo, type Criteria } from '@/lib/recordrepo'

const row = {
  id: '01900000-0000-7000-8000-000000000003',
  happenedAt: new Date('2026-08-01T12:00:00.000Z'),
  utcOffset: '+00:00',
  numericValue: '12.34',
  rawContent: 'raw',
  tags: JSON.stringify(['work', 'urgent']),
  objectiveContext: 'obj',
  aiAnalysis: 'ai',
}

const ROWS = [row]

function base(): Criteria {
  return { tags: [], page: 1, pageSize: 20, sortBy: 'happened_at', sortOrder: 'asc' }
}

beforeEach(() => {
  offset.mockResolvedValue(ROWS)
  offset.mockClear()
  limit.mockClear()
  orderBy.mockClear()
  where.mockClear()
  from.mockClear()
  select.mockClear()
})

describe('findByCriteria validation 400', () => {
  const cases: Array<[string, Criteria, string]> = [
    ['page zero', { ...base(), page: 0 }, 'page must be a positive integer'],
    ['page negative', { ...base(), page: -1 }, 'page must be a positive integer'],
    ['pageSize zero', { ...base(), pageSize: 0 }, 'page_size must be a positive integer'],
    ['sortBy empty', { ...base(), sortBy: '' as never }, 'sort_by must be one of: happened_at, id'],
    ['sortBy invalid', { ...base(), sortBy: 'foo' as never }, 'sort_by must be one of: happened_at, id'],
    ['sortOrder empty', { ...base(), sortOrder: '' as never }, 'sort_order must be one of: asc, desc'],
    ['sortOrder invalid', { ...base(), sortOrder: 'foo' as never }, 'sort_order must be one of: asc, desc'],
  ]

  it.each(cases)('%s → 400 %s', async (_name, c, want) => {
    await expect(Repo.findByCriteria(q, c)).rejects.toMatchObject({
      status: 400,
      message: want,
    })
    expect(select).not.toHaveBeenCalled()
  })
})

describe('findByCriteria conditions', () => {
  it('builds id/from/to/tags/q conditions and paginates', async () => {
    await Repo.findByCriteria(q, {
      ...base(),
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-02T00:00:00.000Z'),
      tags: ['work', 'family:*'],
      q: 'hello world',
      pageSize: 100,
      sortBy: 'id',
    })

    expect(where).toHaveBeenCalledTimes(1)
    expect(orderBy).toHaveBeenCalledTimes(1)
    expect(limit).toHaveBeenCalledTimes(1)
    expect(offset).toHaveBeenCalledTimes(1)
    expect(limit).toHaveBeenCalledWith(100)
    expect(offset).toHaveBeenCalledWith(0)
  })

  it('skips pagination on id path', async () => {
    await Repo.findByCriteria(q, {
      ...base(),
      id: '01900000-0000-7000-8000-000000000099',
      page: 2,
      pageSize: 20,
    })
    expect(limit).not.toHaveBeenCalled()
    expect(offset).not.toHaveBeenCalled()
  })

  it('maps rows through fromDB', async () => {
    const recs = await Repo.findByCriteria(q, base())
    expect(recs).toHaveLength(1)
    expect(recs[0].id).toBe('01900000-0000-7000-8000-000000000003')
    expect(recs[0].happened_at).toBe('2026-08-01T12:00:00.000+00:00')
    expect(recs[0].tags).toEqual(['work', 'urgent'])
  })

  it('wraps driver errors as internal 500', async () => {
    offset.mockRejectedValue(new Error('connection refused'))
    await expect(Repo.findByCriteria(q, base())).rejects.toMatchObject({
      status: 500,
      message: 'Error: connection refused',
    })
  })
})
