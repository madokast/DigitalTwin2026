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
 *
 * 错误约定（与 Go `(T, *myerr.MyError)` 对称）：方法一律 throw MyError（驱动错误
 * newInternal 后 throw），成功路径返回直接值——业务层无拆包样板。
 */

import { and, count, eq, gte, like, lt, or, sql, type SQL } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { fromDB, type Record } from '@/lib/record'
import { parseHappenedAt } from '@/lib/draft'
import { newInternal, newInternalMsg, newNotFound, newValidation } from '@/lib/myerr'
import type { Executor } from '@/db/uow'

export class RecordRepository {
  /** 按 id 查完整行（持久化转换：瞬间 + 隐列 → 带区串，在 fromDB 收敛）；未找到 → throw 404 */
  async findById(q: Executor, id: string): Promise<Record> {
    let rows: typeof schema.records.$inferSelect[]
    try {
      rows = await q
        .select()
        .from(schema.records)
        .where(eq(schema.records.id, id))
        .limit(1)
    } catch (err) {
      throw newInternal(err)
    }
    if (rows.length === 0) {
      throw newNotFound(`record ${id} not found`)
    }
    return fromDB(rows[0])
  }

  /** 只 UPDATE tags（WHERE id）；影响行数 ≠ 1 → 内部错误（D7 并发竞态文案含实际行数）。 */
  async transition(q: Executor, id: string, tags: string[]): Promise<void> {
    let rows: { id: string }[]
    try {
      rows = (await q
        .update(schema.records)
        .set({ tags: JSON.stringify(tags) })
        .where(eq(schema.records.id, id))
        .returning({ id: schema.records.id })) as { id: string }[]
    } catch (err) {
      throw newInternal(err)
    }
    if (rows.length !== 1) {
      throw newInternalMsg(`todo update affected ${rows.length} rows`)
    }
  }

  /** 拿 rename 的 advisory xact lock（业务层事务内第一步调用）。
   * 防并发 rename 读改写循环互相覆盖；锁随事务提交/回滚自动释放。
   * 与 Go `AcquireRenameLock` 对称（key 与 Go renameAdvisoryLockKey 一致）。 */
  async acquireRenameLock(q: Executor): Promise<void> {
    try {
      await q.execute(sql`SELECT pg_advisory_xact_lock(${RENAME_ADVISORY_LOCK_KEY})`)
    } catch (err) {
      throw newInternal(err)
    }
  }

  /** 按过滤条件计数（§6 分层：收 Criteria——类型上不存在分页/排序字段，无需校验）。
   * 方案 B：列表 total 由业务层另行 count；stats total/today、summary 覆盖。 */
  async count(q: Executor, c: Criteria): Promise<number> {
    const where = buildCriteriaWhere(c)
    let rows: { value: number }[]
    try {
      rows = where
        ? ((await q
            .select({ value: count() })
            .from(schema.records)
            .where(where)) as { value: number }[])
        : ((await q
            .select({ value: count() })
            .from(schema.records)) as { value: number }[])
    } catch (err) {
      throw newInternal(err)
    }
    return Number(rows[0]?.value ?? 0)
  }

  /** 按 id 判存在（import 逐行 upsert 用）。竞态语义：并发同 id 时唯一索引兜底
   * （exists→insert 竞态 → 500 整单回滚 = 正确失败语义，保留，见 §10b 步骤 2）。 */
  async exists(q: Executor, id: string): Promise<boolean> {
    let rows: { id: string }[]
    try {
      rows = (await q
        .select({ id: schema.records.id })
        .from(schema.records)
        .where(eq(schema.records.id, id))
        .limit(1)) as { id: string }[]
    } catch (err) {
      throw newInternal(err)
    }
    return rows.length > 0
  }

  /** 全列覆盖（import 逐行 update；INSERT 分支复用 save）。
   * rec 为领域 Record（happened_at 为业务层已校验的请求串，repo 内 parseHappenedAt 重解析
   * 落库——§4 两次解析成本原则，与 save 一致）。无条件覆盖（WHERE id，不检查影响行数
   * ——import 语义 exists=true 才 update，0 行不可达；保守复刻现状行为）。 */
  async update(q: Executor, rec: Record): Promise<void> {
    const happened = parseHappenedAt(rec.happened_at)
    if ('error' in happened) {
      // 数据/格式问题 → 400（业务层已校验，不可达防御）
      throw newValidation(happened.error)
    }
    try {
      await q
        .update(schema.records)
        .set({
          happenedAt: happened.value,
          utcOffset: happened.utcOffset,
          numericValue: rec.numeric_value ?? null,
          rawContent: rec.raw_content,
          tags: JSON.stringify(rec.tags),
          objectiveContext: rec.objective_context,
          aiAnalysis: rec.ai_analysis,
        })
        .where(eq(schema.records.id, rec.id))
    } catch (err) {
      throw newInternal(err)
    }
  }

  /** 单条 INSERT + RETURNING 完整行。rec 为领域 Record（happened_at 为业务层已校验的
   * 请求串，Repository 内 parseHappenedAt 解析落库——接受两次解析成本）；
   * 返回规范化领域 Record（fromDB）——业务层唯一使用的 happened_at 来源。 */
  async save(q: Executor, rec: Record): Promise<Record> {
    const happened = parseHappenedAt(rec.happened_at)
    if ('error' in happened) {
      // 数据/格式问题 → 400（非第三方库错误；业务层已校验，不可达防御）
      throw newValidation(happened.error)
    }
    let rows: typeof schema.records.$inferSelect[]
    try {
      rows = await q
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
    } catch (err) {
      throw newInternal(err)
    }
    return fromDB(rows[0])
  }

  /** 批量 INSERT（循环复用 save 单条原语，行为与顺序确定）；事务内调用。
   * TODO(perf)：当前逐条 insert（N 次往返）。批量场景可优化为 drizzle 多值
   * `.values([...])` 批量插入——注意 returning 顺序不保证与输入一致，需按 id 恢复输入顺序。 */
  async saveAll(q: Executor, recs: Record[]): Promise<Record[]> {
    const out: Record[] = []
    for (const rec of recs) {
      out.push(await this.save(q, rec))
    }
    return out
  }

  /**
   * 按条件查询 records 列表（只返回行；total 由业务层另行 count，方案 B）。
   * 条件构建在 Repository 内部（D3）；fromDB 唯一转换点。
   * id 非空时忽略分页返回 0～1 条（现状语义）。
   * Criteria 非法值（page/pageSize<1、sortBy/sortOrder 空或非法枚举）→ 400（§6：repo 只检测不填补）。
   */
  async findByCriteria(q: Executor, c: FindCriteria): Promise<Record[]> {
    validateCriteria(c)

    const where = buildCriteriaWhere(c)
    const listOrder = sql.raw(recordsOrderBySql(c.sortBy, c.sortOrder))

    let rows: typeof schema.records.$inferSelect[]
    try {
      if (c.id) {
        rows = where
          ? await q.select().from(schema.records).where(where).orderBy(listOrder)
          : await q.select().from(schema.records).orderBy(listOrder)
      } else {
        const offset = (c.page - 1) * c.pageSize
        rows = where
          ? await q
              .select()
              .from(schema.records)
              .where(where)
              .orderBy(listOrder)
              .limit(c.pageSize)
              .offset(offset)
          : await q
              .select()
              .from(schema.records)
              .orderBy(listOrder)
              .limit(c.pageSize)
              .offset(offset)
      }
    } catch (err) {
      throw newInternal(err)
    }
    return rows.map(fromDB)
  }
}

/**
 * 过滤共用字段（§6 分层定案：`count` 收本类型——类型上不存在分页/排序字段）。
 * 校验归属业务层（tag 格式 / 时间解析 / id 格式）；hint 不进 Criteria（响应辅助，业务层 parse 时产出）。
 */
export type Criteria = {
  id?: string // 等值 `id = $n`（query API `?id=` 契约）
  idFrom?: string // keyset 起点 `id >= $n`（export 游标）；与 id 互斥（400 检测）
  from?: Date
  to?: Date
  tags: string[] // 每项精确 tag 或 "family:*" 族通配；空 = 无 tag 过滤
  q?: string // 全文搜索 raw_content / objective_context / ai_analysis / tags
}

/** 查询条件：Criteria + 分页/排序（§6 分层定案）。
 * repo 内零默认、只检测非法值（page/pageSize<1、sortBy/sortOrder 空或非法枚举、id 与 idFrom 互斥 → 400）。 */
export type FindCriteria = Criteria & {
  page: number
  pageSize: number
  sortBy: 'happened_at' | 'id'
  sortOrder: 'asc' | 'desc'
}

/** 条件构建（findByCriteria / count 共享；D3：条件构建在 Repository 内部）。 */
function buildCriteriaWhere(c: Criteria): SQL | undefined {
  const conditions: SQL[] = []
  if (c.id) conditions.push(eq(schema.records.id, c.id))
  if (c.idFrom) conditions.push(gte(schema.records.id, c.idFrom))
  if (c.from) conditions.push(gte(schema.records.happenedAt, c.from))
  if (c.to) conditions.push(lt(schema.records.happenedAt, c.to))
  for (const tag of c.tags) {
    if (tag.endsWith(':*')) {
      // 族通配 `X:*` → `%"X:%`（去尾闭合引号、保留冒号）
      conditions.push(like(schema.records.tags, `%"${escapeLikePattern(tag.slice(0, -1))}%`))
    } else {
      conditions.push(like(schema.records.tags, `%"${escapeLikePattern(tag)}"%`))
    }
  }
  if (c.q) {
    const pattern = `%${escapeLikePattern(c.q)}%`
    // 必须用 or() 包一层，否则 and(...conds) 拼出 tag AND vt OR obj …（AND 优先于 OR）
    conditions.push(
      or(
        like(schema.records.rawContent, pattern),
        like(schema.records.objectiveContext, pattern),
        like(schema.records.aiAnalysis, pattern),
        like(schema.records.tags, pattern),
      )!,
    )
  }
  return conditions.length > 0 ? and(...conditions) : undefined
}

/** 检测非法值 → 400（错误语义：数据/格式问题不限层级；只属 FindCriteria）。文案与 HTTP query parse 层一致。 */
function validateCriteria(c: FindCriteria): void {
  if (c.id && c.idFrom) throw newValidation('id and id_from are mutually exclusive')
  if (c.page < 1) throw newValidation('page must be a positive integer')
  if (c.pageSize < 1) throw newValidation('page_size must be a positive integer')
  if (c.sortBy !== 'happened_at' && c.sortBy !== 'id') {
    throw newValidation('sort_by must be one of: happened_at, id')
  }
  if (c.sortOrder !== 'asc' && c.sortOrder !== 'desc') {
    throw newValidation('sort_order must be one of: asc, desc')
  }
}

/**
 * 转义 LIKE 通配符（PostgreSQL 默认 ESCAPE '\'）。
 * 迁移自 query.escapeLikePattern；步骤 8 接线后删旧实现。
 */
function escapeLikePattern(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

/** 列表查询排序（迁移自 query.recordsOrderBySql；步骤 8 接线后删旧实现）。 */
function recordsOrderBySql(sortBy: 'happened_at' | 'id', sortOrder: 'asc' | 'desc'): string {
  if (sortBy === 'id') {
    return sortOrder === 'desc' ? 'id DESC' : 'id ASC'
  }
  return sortOrder === 'desc' ? 'happened_at DESC, id ASC' : 'happened_at ASC, id ASC'
}

/** rename 的 advisory lock key（与 Go renameAdvisoryLockKey 一致）。 */
const RENAME_ADVISORY_LOCK_KEY = 726478478

/** Repo RecordRepository 模块级单例（空结构体，无状态，安全共享）。 */
export const Repo = new RecordRepository()
