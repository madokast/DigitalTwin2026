/**
 * tags 写库路径（仅服务端）。勿从 Client Component 导入，以免打进 postgres。
 * 纯校验 / JSON 变换仍在 `@/lib/tags`。
 */

import db from '@/db'
import { Repo } from '@/lib/recordrepo'
import { renameTags } from '@/lib/tags'

/** rename 分页循环页大小（与 Go `tags.RenamePageSize` 一致）。 */
export const RENAME_PAGE_SIZE = 100

/**
 * 单事务内将 tags 中 from 重命名为 to（业务层编排，§10b 步骤 2 二次定案）：
 * db.transaction 开事务 → Repo.acquireRenameLock（advisory xact lock：并发 rename 互斥）
 * → 分页循环 Repo.findByCriteria（Criteria{tags:[from], pageSize: RENAME_PAGE_SIZE, sortBy:'id'}）
 * → 每行 renameTags 变换 → Repo.update 写回 → len(页) < RENAME_PAGE_SIZE 终止。
 * 中途失败全滚（任何 DB 错误 → 500）；OFFSET 分页 + 事务内多页：页间并发提交可能跳行/漏改（尽力而为）。
 */
export async function renameAcrossRecords(
  from: string,
  to: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await Repo.acquireRenameLock(tx)
    let updated = 0
    let page = 1
    for (;;) {
      const recs = await Repo.findByCriteria(tx, {
        tags: [from],
        page,
        pageSize: RENAME_PAGE_SIZE,
        sortBy: 'id',
        sortOrder: 'asc',
      })
      for (const rec of recs) {
        const next = renameTags(rec.tags, from, to)
        if (next === null) continue
        rec.tags = next
        await Repo.update(tx, rec)
        updated += 1
      }
      if (recs.length < RENAME_PAGE_SIZE) break
      page += 1
    }
    return updated
  })
}
