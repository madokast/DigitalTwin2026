/**
 * RecordRepository：唯一聚合根的持久化（领域语义方法，内部 SQL）。
 * 构造注入 Executor（非事务 db / 事务 tx 调用形态一致）；无状态，每次现构建。
 * 与 Go `faas/internal/recordrepo` 同构（方法名 camelCase / Go PascalCase，词干一致）。
 *
 * 硬约束：本文件禁止开事务。方法只消费构造注入的 Executor——业务层 UoW 传入的
 * tx（事务内）或非事务 db（直连），绝不调 db.transaction / begin / commit / rollback。
 * 事务边界是业务层 UoW 的职责（`new UoW(db).do(fn)`）；业务层需要多方法同事务时，
 * 在 do 闭包内用同一个 q（= tx）依次调用本文件方法，原子性由业务层这一个事务保证。
 */

import { eq } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { fromDB, type DBRow, type Record } from '@/lib/record'
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

export type RecordSaveAllResult = {
  ok: boolean
  records: Record[]
  error: Error | null
}

export class RecordRepository {
  constructor(private q: Executor) {}

  /** 按 id 查完整行（持久化转换：瞬间 + 隐列 → 带区串，在 fromDB 收敛）；未找到 → RecordNotFoundError */
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
      .set({ tags: JSON.stringify(tags) })
      .where(eq(schema.records.id, id))) as { count: number }
    if (res.count !== 1) {
      return { ok: false, error: new Error(`todo update affected ${res.count} rows`) }
    }
    return { ok: true, error: null }
  }

  /** 单条 INSERT + RETURNING 完整行（row 为 DB 直接映射，SQL 直接消费，零时间字符串转换；返回领域 Record）。 */
  async save(row: DBRow): Promise<RecordSaveResult> {
    const rows = await this.q.insert(schema.records).values(row).returning()
    return { ok: true, record: fromDB(rows[0]), error: null }
  }

  /** 批量 INSERT（循环复用 save 单条原语，行为与顺序确定）；事务内调用。
   * TODO(perf)：当前逐条 insert（N 次往返）。批量场景可优化为 drizzle 多值
   * `.values([...])` 批量插入——注意 returning 顺序不保证与输入一致，需按 id 恢复输入顺序。 */
  async saveAll(rows: DBRow[]): Promise<RecordSaveAllResult> {
    const out: Record[] = []
    for (const row of rows) {
      const res = await this.save(row)
      if (!res.ok) {
        return { ok: false, records: [], error: res.error }
      }
      out.push(res.record!)
    }
    return { ok: true, records: out, error: null }
  }
}
