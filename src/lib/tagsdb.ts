/**
 * tags 写库路径（仅服务端）。勿从 Client Component 导入，以免打进 postgres。
 * 纯校验 / JSON 变换仍在 `@/lib/tags`。
 */

import { eq, sql } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import { renameTagInTagsJson } from '@/lib/tags'

/**
 * renameAcrossRecords 可注入的写库边界（与 Go renameAcrossQuerier / 假 Querier 对称）。
 * 注入时跳过事务与 advisory lock（单测）；生产省略 store，走事务+锁。
 */
export type RenameAcrossRecordsDb = {
  listIdAndTags: () => Promise<{ id: string; tags: string }[]>
  updateTags: (id: string, tags: string) => Promise<void>
}

/** 与 Go tags.TagRenameAdvisoryLockKey 一致 */
export const TAG_RENAME_ADVISORY_LOCK_KEY = 726478478

async function renameAcrossStore(
  from: string,
  to: string,
  store: RenameAcrossRecordsDb,
): Promise<number> {
  const rows = await store.listIdAndTags()
  let updated = 0

  for (const row of rows) {
    const nextTags = renameTagInTagsJson(row.tags, from, to)
    if (nextTags === null) continue
    await store.updateTags(row.id, nextTags)
    updated += 1
  }
  return updated
}

/**
 * 全表扫描 records，将 tags JSON 中 from 重命名为 to。
 * 生产路径：单事务 + pg_advisory_xact_lock（与 Go RenameAcrossRecords 对齐）—
 * 中途失败全滚；并发 rename 互斥。
 * 脏 tags JSON 向上抛错（HTTP 映射 500）。
 * 可选 `store`：测试注入（无真实锁/事务）；生产调用方省略。
 */
export async function renameAcrossRecords(
  from: string,
  to: string,
  store?: RenameAcrossRecordsDb,
): Promise<number> {
  if (store) {
    return renameAcrossStore(from, to, store)
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${TAG_RENAME_ADVISORY_LOCK_KEY})`,
    )
    return renameAcrossStore(from, to, {
      async listIdAndTags() {
        return tx.select({ id: records.id, tags: records.tags }).from(records)
      },
      async updateTags(id, tagsJson) {
        await tx
          .update(records)
          .set({ tags: tagsJson })
          .where(eq(records.id, id))
      },
    })
  })
}
