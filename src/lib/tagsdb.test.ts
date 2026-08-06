/**
 * renameAcrossRecords 业务编排：mock Repo（recordrepo）与 db.transaction，
 * 断言锁、分页循环、逐行变换更新与计数。与 Go tags_db_test.go 对齐。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acquireRenameLock: vi.fn(async () => {}),
  findByCriteria: vi.fn(),
  update: vi.fn(async () => {}),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<number>) => fn({})),
}))

vi.mock('@/lib/recordrepo', () => ({
  Repo: {
    acquireRenameLock: mocks.acquireRenameLock,
    findByCriteria: mocks.findByCriteria,
    update: mocks.update,
  },
}))
vi.mock('@/db', () => ({ default: { transaction: mocks.transaction } }))

import { RENAME_PAGE_SIZE, renameAcrossRecords } from '@/lib/tagsdb'

function rec(id: string, tags: string[]) {
  return {
    id,
    happened_at: '2026-08-01T12:00:00.000+00:00',
    raw_content: 'raw',
    objective_context: 'obj',
    ai_analysis: null,
    tags,
  }
}

beforeEach(() => {
  mocks.acquireRenameLock.mockClear()
  mocks.findByCriteria.mockClear()
  mocks.update.mockClear()
  mocks.transaction.mockClear()
})

describe('renameAcrossRecords', () => {
  it('locks first, pages, transforms and updates each row', async () => {
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['weight', 'morning']), rec('id-2', ['weight'])])
    const updated = await renameAcrossRecords('weight', 'mass')
    expect(updated).toBe(2)
    expect(mocks.acquireRenameLock).toHaveBeenCalledTimes(1)
    expect(mocks.findByCriteria).toHaveBeenCalledTimes(1)
    expect(mocks.findByCriteria).toHaveBeenCalledWith(
      {},
      { tags: ['weight'], page: 1, pageSize: RENAME_PAGE_SIZE, sortBy: 'id', sortOrder: 'asc' },
    )
    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(mocks.update).toHaveBeenNthCalledWith(1, {}, rec('id-1', ['mass', 'morning']))
    expect(mocks.update).toHaveBeenNthCalledWith(2, {}, rec('id-2', ['mass']))
  })

  it('paginates until a short page, page increments', async () => {
    const page1 = Array.from({ length: RENAME_PAGE_SIZE }, (_, i) => rec(`id-${i}`, ['weight']))
    mocks.findByCriteria.mockResolvedValueOnce(page1)
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-last', ['weight', 'weight:extra'])])
    const updated = await renameAcrossRecords('weight', 'mass')
    expect(updated).toBe(RENAME_PAGE_SIZE + 1)
    expect(mocks.findByCriteria).toHaveBeenCalledTimes(2)
    expect(mocks.findByCriteria).toHaveBeenNthCalledWith(
      2,
      {},
      { tags: ['weight'], page: 2, pageSize: RENAME_PAGE_SIZE, sortBy: 'id', sortOrder: 'asc' },
    )
    expect(mocks.update).toHaveBeenCalledTimes(RENAME_PAGE_SIZE + 1)
  })

  it('skips rows without from and returns 0', async () => {
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['alpha'])])
    const updated = await renameAcrossRecords('weight', 'mass')
    expect(updated).toBe(0)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('dedupes when to already present', async () => {
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['job', 'work', 'x'])])
    const updated = await renameAcrossRecords('work', 'job')
    expect(updated).toBe(1)
    expect(mocks.update).toHaveBeenCalledWith({}, rec('id-1', ['job', 'x']))
  })
})
