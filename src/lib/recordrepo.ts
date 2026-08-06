/**
 * RecordRepository：唯一聚合根的持久化（领域语义方法，内部 SQL）。
 * 构造注入 Executor（非事务 db / 事务 tx 调用形态一致）；无状态，每次现构建。
 * 与 Go `faas/internal/recordrepo` 同构（方法名 camelCase / Go PascalCase，词干一致）。
 */

import { eq } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { fromDB, tagsJSON, type Record, type RecordRow } from '@/lib/record'
import { RecordNotFoundError } from '@/lib/record/errors'
import type { Executor } from '@/db/uow'

export type RecordFindByIDResult = {
  ok: boolean
  record: Record | null
  error: Error | null
}

export type RecordTransitionResult = {
  ok: boolean
  error: Error | null
}

export type RecordSaveResult = {
  ok: boolean
  record: Record | null
  error: Error | null
}

export class RecordRepository {
  constructor(private q: Executor) {}

  /** 按 id 查完整行；未找到 → RecordNotFoundError */
  async findById(id: string): Promise<RecordFindByIDResult> {
    const rows = await this.q
      .select()
      .from(schema.records)
      .where(eq(schema.records.id, id))
      .limit(1)
    if (rows.length === 0) {
      return { ok: false, record: null, error: new RecordNotFoundError(`record ${id} not found`) }
    }
    return { ok: true, record: fromDB(rows[0]), error: null }
  }

  /** 只 UPDATE tags（WHERE id）；影响行数 ≠ 1 → 错误（D7 并发竞态文案含实际行数）。 */
  async transition(id: string, tags: string[]): Promise<RecordTransitionResult> {
    const res = (await this.q
      .update(schema.records)
      .set({ tags: tagsJSON(tags) })
      .where(eq(schema.records.id, id))) as { count: number }
    if (res.count !== 1) {
      return { ok: false, error: new Error(`todo update affected ${res.count} rows`) }
    }
    return { ok: true, error: null }
  }

  /** 单条 INSERT + RETURNING 完整行（row 含隐列 utcOffset）。 */
  async save(row: RecordRow): Promise<RecordSaveResult> {
    const rows = await this.q
      .insert(schema.records)
      .values({
        ...row,
        happenedAt:
          row.happenedAt instanceof Date ? row.happenedAt : new Date(row.happenedAt),
      })
      .returning()
    return { ok: true, record: fromDB(rows[0]), error: null }
  }
}
