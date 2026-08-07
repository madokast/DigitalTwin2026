/**
 * tagsService.renameAcrossRecords 业务编排：mock Repo（recordrepo）与 db.transaction，
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

import { NORMALIZE_PAGE_SIZE, tagsService } from '@/lib/tagsdb'

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

describe('tagsService.normalizeAcrossRecords', () => {
  it('locks first, scans per source tag, transforms and updates each row', async () => {
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['workout', 'morning']), rec('id-2', ['workout'])])
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-3', ['workout:arm'])])
    const updated = await tagsService.normalizeAcrossRecords(['workout', 'workout:arm'], 'training')
    expect(updated).toBe(3)
    expect(mocks.acquireRenameLock).toHaveBeenCalledTimes(1)
    // 每个 from 元素各分页扫描一次（AND 交集语义不能一次匹配任一）
    expect(mocks.findByCriteria).toHaveBeenCalledTimes(2)
    expect(mocks.findByCriteria).toHaveBeenNthCalledWith(
      1,
      {},
      { tags: ['workout'], page: 1, pageSize: NORMALIZE_PAGE_SIZE, sortBy: 'id', sortOrder: 'asc' },
    )
    // 每个 from 元素各自从 page 1 开始扫描（上一源短页即终止）
    expect(mocks.findByCriteria).toHaveBeenNthCalledWith(
      2,
      {},
      { tags: ['workout:arm'], page: 1, pageSize: NORMALIZE_PAGE_SIZE, sortBy: 'id', sortOrder: 'asc' },
    )
    // 多源一次变换：删全部 from + 尾加 to
    expect(mocks.update).toHaveBeenCalledTimes(3)
    expect(mocks.update).toHaveBeenNthCalledWith(1, {}, rec('id-1', ['morning', 'training']))
    expect(mocks.update).toHaveBeenNthCalledWith(2, {}, rec('id-2', ['training']))
    expect(mocks.update).toHaveBeenNthCalledWith(3, {}, rec('id-3', ['training']))
  })

  it('paginates until a short page, page increments per source', async () => {
    const page1 = Array.from({ length: NORMALIZE_PAGE_SIZE }, (_, i) => rec(`id-${i}`, ['weight']))
    mocks.findByCriteria.mockResolvedValueOnce(page1)
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-last', ['weight'])])
    const updated = await tagsService.normalizeAcrossRecords(['weight'], 'mass')
    expect(updated).toBe(NORMALIZE_PAGE_SIZE + 1)
    expect(mocks.findByCriteria).toHaveBeenCalledTimes(2)
    expect(mocks.findByCriteria).toHaveBeenNthCalledWith(
      2,
      {},
      { tags: ['weight'], page: 2, pageSize: NORMALIZE_PAGE_SIZE, sortBy: 'id', sortOrder: 'asc' },
    )
    expect(mocks.update).toHaveBeenCalledTimes(NORMALIZE_PAGE_SIZE + 1)
  })

  it('skips rows without any from tag and returns 0', async () => {
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['alpha'])])
    const updated = await tagsService.normalizeAcrossRecords(['weight'], 'mass')
    expect(updated).toBe(0)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('does not re-update a row already normalized by an earlier source', async () => {
    // 第一源 work 扫描命中并更新（→ ['urgent', 'job']）；
    // 第二源 walk 扫描返回同一行时 normalizeTags 已无命中 → 不重复写
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['work', 'urgent'])])
    mocks.findByCriteria.mockResolvedValueOnce([rec('id-1', ['urgent', 'job'])])
    const updated = await tagsService.normalizeAcrossRecords(['work', 'walk'], 'job')
    expect(updated).toBe(1)
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith({}, rec('id-1', ['urgent', 'job']))
  })
})
