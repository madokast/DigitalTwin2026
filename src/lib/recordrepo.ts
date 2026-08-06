/**
 * RecordRepository：唯一聚合根的持久化（领域语义方法，内部 SQL）。
 * 空结构体（无状态），以模块级单例 Repo 暴露；方法第一参数显式收执行器 q
 * （非事务 db / 事务 tx 调用形态一致）。
 * 与 Go `faas/internal/recordrepo` 同构（方法名 camelCase / Go PascalCase，词干一致）。
 *
 * 硬约束：本文件禁止开事务。方法只消费显式传入的 Executor——业务层 UoW 传入的
 * tx（事务内）或非事务 db（直连），绝不调 db.transaction / begin / commit / rollback。
 * 事务边界是业务层 UoW 的职责（`new UoW(db).do(fn)`）；业务层需要多方法同事务时，
 * 在 do 闭包内用同一个 q（= tx）依次调用本文件方法，原子性由业务层这一个事务保证。
 */

import { eq } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { fromDB, type Record } from '@/lib/record'
import { parseHappenedAt } from '@/lib/draft'
import { newInternal, newNotFound, type MyError } from '@/lib/myerr'
import type { Executor } from '@/db/uow'

export type RecordFindByIDResult = {
  ok: boolean
  record: Record | null
  error: MyError | null
}

export type RecordTransitionResult = {
  ok: boolean
  error: MyError | null
}

export type RecordSaveResult = {
  ok: boolean
  record: Record | null
  error: MyError | null
}

export type RecordSaveAllResult = {
  ok: boolean
  records: Record[]
  error: MyError | null
}

export class RecordRepository {
  /** 按 id 查完整行（持久化转换：瞬间 + 隐列 → 带区串，在 fromDB 收敛）；未找到 → myerr 404 */
  async findById(q: Executor, id: string): Promise<RecordFindByIDResult> {
    const rows = await q
      .select()
      .from(schema.records)
      .where(eq(schema.records.id, id))
      .limit(1)
    if (rows.length === 0) {
      return { ok: false, record: null, error: newNotFound(`record ${id} not found`) }
    }
    return { ok: true, record: fromDB(rows[0]), error: null }
  }

  /** 只 UPDATE tags（WHERE id）；影响行数 ≠ 1 → 内部错误（D7 并发竞态文案含实际行数）。 */
  async transition(q: Executor, id: string, tags: string[]): Promise<RecordTransitionResult> {
    const res = (await q
      .update(schema.records)
      .set({ tags: JSON.stringify(tags) })
      .where(eq(schema.records.id, id))) as { count: number }
    if (res.count !== 1) {
      return { ok: false, error: newInternal(new Error(`todo update affected ${res.count} rows`)) }
    }
    return { ok: true, error: null }
  }

  /** 单条 INSERT + RETURNING 完整行。rec 为领域 Record（happened_at 为业务层已校验的
   * 请求串，Repository 内 parseHappenedAt 解析落库——接受两次解析成本）；
   * 返回规范化领域 Record（fromDB）——业务层唯一使用的 happened_at 来源。 */
  async save(q: Executor, rec: Record): Promise<RecordSaveResult> {
    const happened = parseHappenedAt(rec.happened_at)
    if ('error' in happened) {
      return { ok: false, record: null, error: newInternal(new Error(happened.error)) }
    }
    const rows = await q
      .insert(schema.records)
      .values({
        id: rec.id,
        happenedAt: happened.value,
        utcOffset: happened.utcOffset,
        numericValue: rec.numeric_value ?? null,
        rawContent: rec.raw_content,
        tags: JSON.stringify(rec.tags),
        objectiveContext: rec.objective_context,
        aiAnalysis: rec.ai_analysis,
      })
      .returning()
    return { ok: true, record: fromDB(rows[0]), error: null }
  }

  /** 批量 INSERT（循环复用 save 单条原语，行为与顺序确定）；事务内调用。
   * TODO(perf)：当前逐条 insert（N 次往返）。批量场景可优化为 drizzle 多值
   * `.values([...])` 批量插入——注意 returning 顺序不保证与输入一致，需按 id 恢复输入顺序。 */
  async saveAll(q: Executor, recs: Record[]): Promise<RecordSaveAllResult> {
    const out: Record[] = []
    for (const rec of recs) {
      const res = await this.save(q, rec)
      if (!res.ok) {
        return { ok: false, records: [], error: res.error }
      }
      out.push(res.record!)
    }
    return { ok: true, records: out, error: null }
  }
}

/** Repo RecordRepository 模块级单例（空结构体，无状态，安全共享）。 */
export const Repo = new RecordRepository()
