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

const updateWhere = vi.fn()
const updateSet = vi.fn(() => ({ where: updateWhere }))
const update = vi.fn(() => ({ set: updateSet }))

const insertWhere = vi.fn()
const insertValues = vi.fn(() => ({ where: insertWhere }))
const insert = vi.fn(() => ({ values: insertValues }))

// findByCriteria 直接收执行器 q（无 db 顶层 import）；q 即 mock builder 链。
const execute = vi.fn()
const q = { select, update, insert, execute } as unknown as Executor

import type { Executor } from '@/db/uow'
import * as schema from '@/db/schema'
import { Repo, type FindCriteria } from '@/lib/recordrepo'

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

function base(): FindCriteria {
  return { tags: [], page: 1, pageSize: 20, sortBy: 'happened_at', sortOrder: 'asc' }
}

beforeEach(() => {
  execute.mockClear()
  updateWhere.mockClear()
  updateSet.mockClear()
  update.mockClear()
  insertWhere.mockClear()
  insertValues.mockClear()
  insert.mockClear()
  offset.mockResolvedValue(ROWS)
  offset.mockClear()
  limit.mockClear()
  orderBy.mockClear()
  where.mockClear()
  from.mockClear()
  select.mockClear()
})

describe('findByCriteria validation 400', () => {
  const cases: Array<[string, FindCriteria, string]> = [
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

describe('exists', () => {
  const exLimit = vi.fn()
  const exWhere = vi.fn(() => ({ limit: exLimit }))
  const exFrom = vi.fn(() => ({ where: exWhere }))
  const exSelect = vi.fn(() => ({ from: exFrom }))
  const exQ = { select: exSelect } as unknown as Executor

  it('returns true when a row matches', async () => {
    exLimit.mockResolvedValue([{ id: '01900000-0000-7000-8000-000000000003' }])
    const exists = await Repo.exists(exQ, '01900000-0000-7000-8000-000000000003')
    expect(exists).toBe(true)
  })

  it('returns false when no row matches', async () => {
    exLimit.mockResolvedValue([])
    const exists = await Repo.exists(exQ, '01900000-0000-7000-8000-000000000003')
    expect(exists).toBe(false)
  })

  it('wraps driver errors as internal 500', async () => {
    exLimit.mockRejectedValue(new Error('connection refused'))
    await expect(Repo.exists(exQ, 'id')).rejects.toMatchObject({
      status: 500,
      message: 'Error: connection refused',
    })
  })
})

describe('update', () => {
  it('updates all columns and re-parses utc_offset from happened_at', async () => {
    updateWhere.mockResolvedValue([])
    await Repo.update(q, {
      id: '01900000-0000-7000-8000-000000000003',
      happened_at: '2026-08-01T12:00:00.000+08:00',
      numeric_value: '12.34',
      raw_content: 'raw',
      objective_context: 'obj',
      ai_analysis: 'ai',
      tags: ['work', 'urgent'],
    })
    expect(update).toHaveBeenCalledTimes(1)
    expect(updateSet).toHaveBeenCalledTimes(1)
    expect(updateWhere).toHaveBeenCalledTimes(1)
    expect(updateSet).toHaveBeenCalledWith({
      happenedAt: new Date('2026-08-01T04:00:00.000Z'),
      utcOffset: '+08:00',
      numericValue: '12.34',
      rawContent: 'raw',
      tags: JSON.stringify(['work', 'urgent']),
      objectiveContext: 'obj',
      aiAnalysis: 'ai',
    })
  })

  it('rejects invalid happened_at as 400', async () => {
    await expect(
      Repo.update(q, {
        id: '01900000-0000-7000-8000-000000000003',
        happened_at: 'not-a-datetime',
        raw_content: null,
        objective_context: '',
        ai_analysis: null,
        tags: [],
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(update).not.toHaveBeenCalled()
  })

  it('wraps driver errors as internal 500', async () => {
    updateWhere.mockRejectedValue(new Error('connection refused'))
    await expect(
      Repo.update(q, {
        id: '01900000-0000-7000-8000-000000000003',
        happened_at: '2026-08-01T12:00:00.000+08:00',
        raw_content: null,
        objective_context: '',
        ai_analysis: null,
        tags: [],
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: 'Error: connection refused',
    })
  })
})

describe('acquireRenameLock', () => {
  it('executes pg_advisory_xact_lock with the shared key', async () => {
    execute.mockResolvedValue(undefined)
    await Repo.acquireRenameLock(q)
    expect(execute).toHaveBeenCalledTimes(1)
    // drizzle sql 模板节点：queryChunks 含模板串与 key 数字
    const node = execute.mock.calls[0][0] as { queryChunks: unknown[] }
    expect(JSON.stringify(node.queryChunks)).toContain('726478478')
    expect(JSON.stringify(node.queryChunks)).toContain('pg_advisory_xact_lock')
  })

  it('wraps driver errors as internal 500', async () => {
    execute.mockRejectedValue(new Error('connection refused'))
    await expect(Repo.acquireRenameLock(q)).rejects.toMatchObject({
      status: 500,
      message: 'Error: connection refused',
    })
  })
})

describe('findByCriteria idFrom', () => {
  it('builds id >= keyset condition and paginates', async () => {
    await Repo.findByCriteria(q, {
      ...base(),
      idFrom: '01900000-0000-7000-8000-000000000003',
    })
    expect(where).toHaveBeenCalledTimes(1)
    expect(limit).toHaveBeenCalledTimes(1)
    expect(offset).toHaveBeenCalledWith(0)
  })

  it('rejects id + idFrom together as 400', async () => {
    await expect(
      Repo.findByCriteria(q, {
        ...base(),
        id: '01900000-0000-7000-8000-000000000001',
        idFrom: '01900000-0000-7000-8000-000000000002',
      }),
    ).rejects.toMatchObject({ status: 400, message: 'id and id_from are mutually exclusive' })
    expect(select).not.toHaveBeenCalled()
  })
})

describe('count', () => {
  it('returns total without filter', async () => {
    const cFrom = vi.fn(() => ({
      then: (resolve: (v: unknown) => void) => resolve([{ value: 42 }]),
    }))
    const cSelect = vi.fn(() => ({ from: cFrom }))
    const cQ = { select: cSelect } as unknown as Executor
    const total = await Repo.count(cQ, { tags: [] })
    expect(total).toBe(42)
  })

  it('returns total with conditions', async () => {
    const cWhere = vi.fn(() => ({
      then: (resolve: (v: unknown) => void) => resolve([{ value: 7 }]),
    }))
    const cFrom = vi.fn(() => ({ where: cWhere }))
    const cSelect = vi.fn(() => ({ from: cFrom }))
    const cQ = { select: cSelect } as unknown as Executor
    const total = await Repo.count(cQ, {
      from: new Date('2026-08-01T00:00:00.000Z'),
      tags: ['work'],
    })
    expect(total).toBe(7)
    expect(cWhere).toHaveBeenCalledTimes(1)
  })

  it('wraps driver errors as internal 500', async () => {
    const cFrom = vi.fn(() => ({
      then: (_resolve: (v: unknown) => void) => {
        throw new Error('connection refused')
      },
    }))
    const cSelect = vi.fn(() => ({ from: cFrom }))
    const cQ = { select: cSelect } as unknown as Executor
    await expect(Repo.count(cQ, { tags: [] })).rejects.toMatchObject({
      status: 500,
      message: 'Error: connection refused',
    })
  })
})

describe('attachTag / detachTag', () => {
  // 全局部链：顶部共享 updateWhere 会被 update 测试的 mockResolvedValue 污染
  const atReturning = vi.fn()
  const atUpdateWhere = vi.fn(() => ({ returning: atReturning }))
  const atUpdateSet = vi.fn(() => ({ where: atUpdateWhere }))
  const atUpdate = vi.fn(() => ({ set: atUpdateSet }))
  const atForUpdate = vi.fn()
  const atWhere = vi.fn(() => ({ for: atForUpdate }))
  const atFrom = vi.fn(() => ({ where: atWhere }))
  const atSelect = vi.fn(() => ({ from: atFrom }))
  const atQ = { select: atSelect, update: atUpdate, insert, execute } as unknown as Executor

  beforeEach(() => {
    atReturning.mockClear()
    atUpdateWhere.mockClear()
    atUpdateSet.mockClear()
    atUpdate.mockClear()
    atForUpdate.mockClear()
    atWhere.mockClear()
    atFrom.mockClear()
    atSelect.mockClear()
  })

  it('attach appends and updates tags', async () => {
    atForUpdate.mockResolvedValue([{ tags: JSON.stringify(['exercise']) }])
    atReturning.mockResolvedValue([{ id: 'id-1' }])
    const res = await Repo.attachTag(atQ, 'id-1', 'workout:arm')
    expect(res).toEqual({
      from: ['exercise'],
      to: ['exercise', 'workout:arm'],
      changed: true,
    })
    expect(atSelect).toHaveBeenCalledWith({ tags: schema.records.tags })
    expect(atForUpdate).toHaveBeenCalledWith('update')
    expect(atUpdateSet).toHaveBeenCalledWith({ tags: JSON.stringify(['exercise', 'workout:arm']) })
  })

  it('attach duplicate returns changed:false and skips update', async () => {
    atForUpdate.mockResolvedValue([{ tags: JSON.stringify(['a', 'b']) }])
    const res = await Repo.attachTag(atQ, 'id-1', 'b')
    expect(res).toEqual({ from: ['a', 'b'], to: ['a', 'b'], changed: false })
    expect(atUpdate).not.toHaveBeenCalled()
  })

  it('attach missing record throws 404', async () => {
    atForUpdate.mockResolvedValue([])
    await expect(Repo.attachTag(atQ, 'missing', 't')).rejects.toMatchObject({
      status: 404,
      message: 'record missing not found',
    })
    expect(atUpdate).not.toHaveBeenCalled()
  })

  it('attach recovers from dirty non-array tags', async () => {
    atForUpdate.mockResolvedValue([{ tags: '{"not":"array"}' }])
    atReturning.mockResolvedValue([{ id: 'id-1' }])
    const res = await Repo.attachTag(atQ, 'id-1', 't')
    expect(res).toEqual({ from: [], to: ['t'], changed: true })
  })

  it('detach removes in place preserving order', async () => {
    atForUpdate.mockResolvedValue([{ tags: JSON.stringify(['a', 'b', 'c']) }])
    atReturning.mockResolvedValue([{ id: 'id-1' }])
    const res = await Repo.detachTag(atQ, 'id-1', 'b')
    expect(res).toEqual({ from: ['a', 'b', 'c'], to: ['a', 'c'], changed: true })
    expect(atUpdateSet).toHaveBeenCalledWith({ tags: JSON.stringify(['a', 'c']) })
  })

  it('detach absent tag returns changed:false and skips update', async () => {
    atForUpdate.mockResolvedValue([{ tags: JSON.stringify(['a']) }])
    const res = await Repo.detachTag(atQ, 'id-1', 'zzz')
    expect(res).toEqual({ from: ['a'], to: ['a'], changed: false })
    expect(atUpdate).not.toHaveBeenCalled()
  })

  it('edit affecting zero rows throws internal 500', async () => {
    atForUpdate.mockResolvedValue([{ tags: JSON.stringify(['a']) }])
    atReturning.mockResolvedValue([])
    await expect(Repo.attachTag(atQ, 'id-1', 'b')).rejects.toMatchObject({
      status: 500,
      message: 'tag edit affected 0 rows',
    })
  })
})
