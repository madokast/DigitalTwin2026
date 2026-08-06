import db from '@/db'
import * as schema from '@/db/schema'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

// DbTransaction 从实际 db.transaction 回调参数提取的 drizzle 事务类型
// （不手写 PgTransaction 泛型参数，随 drizzle 版本自动对齐）。
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Executor 可执行器形状（drizzle db 与事务 tx 的公共方法集）。
// 与 Go `Executor` 同名对齐（AGENTS.md 双端同构）；Node 无 Tx/TxBeginner 对应类型——
// drizzle `db.transaction` 已封装事务边界（Commit/Rollback 由框架管）。
export type Executor = PostgresJsDatabase<typeof schema> | DbTransaction

// UoW 事务机制封装（与 Go db.UoW.Do 同构）。
// 业务层只调 do，决定「用不用事务」；begin/commit/rollback 由 drizzle transaction 管理。
// 构造注入 db（生产传 '@/db' 单例；测试传 mock）。
export class UoW {
  constructor(private dbbase: typeof db) {}

  do<T>(fn: (q: Executor) => Promise<T>): Promise<T> {
    return this.dbbase.transaction(async (tx) => fn(tx as Executor))
  }
}
