import db from '@/db'
type Db = typeof db
const dbDefault = db

/**
 * TagsService（§10b 步骤 4：class + 构造注入 db；模块级单例）。
 */
export class TagsService {
  constructor(private readonly db: Db = dbDefault) {}

  /** 追加单个普通 tag（UoW 事务 + Repo 原语；校验零 DB 在 route）。 */
  async attachTag(id: string, tag: string): Promise<EditTagsResult> {
    return this.db.transaction(async (tx) => Repo.attachTag(tx, id, tag))
  }

  /** 删除单个普通 tag。 */
  async detachTag(id: string, tag: string): Promise<EditTagsResult> {
    return this.db.transaction(async (tx) => Repo.detachTag(tx, id, tag))
  }

  /**
   * 单事务内全表归一化（from 系列 → to；锁 + 分页循环）。
   * 对每个 from 元素分页扫描（FindByCriteria 的 tags 为 AND 交集语义，不能一次匹配任一；
   * 每行 normalizeTags 一次多源变换——顺序语义定案「删 from 系列 + 尾加 to」）。
   * 同一行含多个 from 元素：首次命中更新，后续 normalizeTags 返回 null 不重复写。
   */
  async normalizeAcrossRecords(from: string[], to: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await Repo.acquireRenameLock(tx)
      let updated = 0
      for (const f of from) {
        let page = 1
        for (;;) {
          const recs = await Repo.findByCriteria(tx, {
            tags: [f],
            page,
            pageSize: NORMALIZE_PAGE_SIZE,
            sortBy: 'id',
            sortOrder: 'asc',
          })
          for (const rec of recs) {
            const next = normalizeTags(rec.tags, from, to)
            if (next === null) continue
            rec.tags = next
            await Repo.update(tx, rec)
            updated += 1
          }
          if (recs.length < NORMALIZE_PAGE_SIZE) break
          page += 1
        }
      }
      return updated
    })
  }
}

/** 模块级单例（route 装配；vi.mock 兼容）。 */
export const tagsService = new TagsService()

/**
 * tags 写库路径（仅服务端）。勿从 Client Component 导入，以免打进 postgres。
 * 纯校验 / JSON 变换仍在 `@/lib/tags`。
 */


import { Repo } from '@/lib/recordrepo'
import type { EditTagsResult } from '@/lib/recordrepo'
import { normalizeTags } from '@/lib/tags'

/** normalize 分页循环页大小（与 Go `tags.NormalizePageSize` 一致）。 */
export const NORMALIZE_PAGE_SIZE = 100

/**
 * 单事务内全表归一化（normalize 定案；见 normalizeAcrossRecords 方法注释）。
 * 中途失败全滚（任何 DB 错误 → 500）；OFFSET 分页 + 事务内多页：页间并发提交可能跳行/漏改（尽力而为）。
 */

