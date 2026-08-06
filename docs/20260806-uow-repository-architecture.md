# UoW + Repository 架构定案（最终稿）

> 创建日期：2026-08-06
> 性质：**最终定案文档**（终稿）。取代 2026-08-05 的三份文档——`20260805-repository-architecture.md`（初版定案）、`20260805-repository-architecture-review.md`（15 项审查记录）、`20260805-uow-repository-reference.md`（参考代码）——审查过程与历次模型修订见 git history（每项定案均有独立 commit），不在此重复。
> 触发：`log/numbers` 批量验收发现业务层直接耦合 `*pgxpool.Pool` 无法 mock DB 测回滚；tags 增删接口（`docs/20260805-tags-add.md`）定案采用本架构。

## 1. 领域模型与分层

- **唯一聚合根 = Record**（数据库仅 `records` 一张表；Number / Text / Todo / Review / Transaction / BodyWeight 均为 tag 变体）→ **唯一 Repository = `RecordRepository`**（单数，DDD 惯例）。
- Todo / Transaction 是 Record 上的操作，由**业务层（Service）**编排，复用 `RecordRepository`。
- **dbprobe 排除**：基础设施健康检查（独立连接 + `select 1` + 表存在性），非领域查询，不进 Repository。

| 层 | 职责 | 依赖 |
|---|---|---|
| **业务层（Service）** | 参数解析与校验（**零 DB**）；**决定用不用事务**（经 UoW）；编排领域操作；组织响应 | `db`（执行器源）、`UoW`、`RecordRepository` |
| **Repository**（`RecordRepository`） | 领域语义持久化方法（非 SQL 透传）；存在性 / 重复性 / 并发（CAS）；**不管理事务** | 构造注入的 `Executor` |
| **Executor** | DB 访问句柄：Go `*pgxpool.Pool` / `pgx.Tx` 均满足；Node drizzle `db` / 事务 `tx` 均满足 | — |
| **UnitOfWork（UoW）** | 事务边界：`begin / rollback / commit` 机制封装 | 构造注入的事务起点 |

- **业务层不得直接发 SQL**——写路径与读路径全部经 `RecordRepository`（Service 持有的 `db` 仅作执行器源传给 repo / UoW）。
- **UoW 在业务层，不在 Repository**（DDD 规范：事务边界是 UoW 的职责）。**硬约束：Repository 内禁止开事务**——方法只消费构造注入的 `Executor`（业务层 UoW 传入的 tx 或非事务 pool），绝不调用 `Begin`/`Commit`/`Rollback`；业务层需多方法同事务时，在 `uow.Do` 闭包内用同一个 `q`（= tx）依次调用 repo 方法，原子性由业务层这一个事务保证。

## 2. 形态（双端一致，2026-08-06 定案）

**Service 结构体 / class + 依赖注入**；**Repository 无状态、每次现构建**（构造注入执行器）；**事务边界在 Service 方法内部**（UoW 封装机制）。

```go
// Go（faas/internal/logapi/service.go 等）
type Service struct {
	db  *pgxpool.Pool // 执行器源（单条路径直接当 Executor 用）
	uow *db.UoW       // 事务源
}

// 单条（无事务）：db 直接注入 repo
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
	repo := recordrepo.New(s.db)
	res := repo.FindByID(ctx, id)
	if !res.OK {
		return nil, res.Error
	}
	return res.User, nil
}

// 多语句（事务）：UoW 包，闭包收执行器（= tx）
func (s *Service) Transfer(ctx context.Context, fromID, toID string, amount int64) error {
	return s.uow.Do(ctx, func(q db.Executor) error {
		repo := recordrepo.New(q)
		if err := repo.DecreaseBalance(ctx, fromID, amount); err != nil {
			return err
		}
		return repo.IncreaseBalance(ctx, toID, amount)
	})
}
```

```ts
// Node（src/lib/service.ts）
class Service {
  constructor(private db: Db, private uow: UoW) {}

  // 单条（无事务）
  async getUser(id: string): Promise<User | null> {
    const res = await new RecordRepository(this.db).findById(id)
    if (!res.ok) throw res.error
    return res.user
  }

  // 多语句（事务）
  async transfer(fromID: string, toID: string, amount: number): Promise<void> {
    return this.uow.do(async (q) => {
      const repo = new RecordRepository(q)
      await repo.decreaseBalance(fromID, amount)
      await repo.increaseBalance(toID, amount)
    })
  }
}
```

**要点**：
- Service 方法内部决定「用不用事务」：单条直接 `repo` 用 `s.db`；多语句 `s.uow.Do` 包，闭包内 `repo` 收 `tx`（两者都满足 `Executor`，repo 构造形态一致）。
- **预读位置按业务语义**：CAS 操作（attachTag/detachTag——旧 tags 参与写 WHERE）预读**必须在同一事务**；非 CAS（transition——预读只用于判断与组装）预读**在事务外**，准备好才开事务，事务持有时间最短。
- **嵌套支持**：Go `pgx.Tx` 亦满足 `TxBeginner`（savepoint），Service 可在外层事务内被调用。

## 3. 三层接口 + UoW（Go `db` 包 / Node `src/db/uow.ts`）

```go
// faas/internal/db/uow.go
type Executor interface { // 统一，取代 rowQuerier / transitionDB / db.Querier
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
type Tx interface { // pgx.Tx 满足
	Executor
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}
type TxBeginner interface { // *pgxpool.Pool（经 NewPoolTxBeginner 适配）与 pgx.Tx（savepoint，同上适配）满足
	Executor
	Begin(ctx context.Context) (Tx, error) // 返回自定义 Tx——Go 接口方法返回类型不协变，db 包内部
	// 用 txAdapter{pgx.Tx} 适配（pgx 类型不出 db 包）；测试 fake 只需实现 5 个方法
}

// db 包内部：txAdapter 包装 pgx.Tx；poolTxBeginner 包装 *pgxpool.Pool；导出 NewPoolTxBeginner(pool)（nil→nil）。
// UoW 事务机制封装（begin / rollback / commit），业务层只调 Do：
type UoW struct{ pool TxBeginner }
func NewUoW(pool *pgxpool.Pool) *UoW // 内部 NewPoolTxBeginner；测试同包直接 &UoW{pool: fake}
func (u *UoW) Do(ctx context.Context, fn func(q Executor) error) error {
	tx, err := u.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
```

```ts
// src/db/uow.ts
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type Executor = PostgresJsDatabase<typeof schema> | DbTransaction // 已实测 select/update/execute 链 typecheck

export class UoW {
  constructor(private db: Db) {}
  do<T>(fn: (q: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(tx as Executor))
  }
}
```

- `Server.Pool` 字段 `*pgxpool.Pool` → `db.TxBeginner`（`NewServer` 仍收 `*pgxpool.Pool`，自动满足）；`Server` 构造 `db.NewUoW(pool)` 注入各 Service。
- 分层强约束：**业务层禁止调用 Executor 的 SQL 方法**——`Executor` 仅 Repository / UoW 内部使用。

## 4. 领域错误体系（A2 / A3 定案 + 阶段 B）

**DDD Error 一套（双端对称）**——message 固定或运行时拼接：

```go
// faas/internal/record/errors.go
var (
	ErrNotFound = errors.New("record not found")
	ErrConflict = errors.New("record tags changed concurrently, retry")
)
// 运行时拼接：fmt.Errorf("record %s not found: %w", id, record.ErrNotFound)
// 阶段 B（UoW 落地时）：ErrInternal —— InternalError 类型 + ErrInternal(err) 包装，
// 存原始 err + Unwrap() 保链（Error() 返回原文、errors.As 命中、底层链仍可 errors.Is 穿透）；
// Repository 在此吸收三方库错误（防腐层，唯一碰 SQL 的层）。见 docs/20260806-internal-error-transparency.md。
```

```ts
// src/lib/record/errors.ts
export class RecordNotFoundError extends Error {}
export class RecordConflictError extends Error {}
// 阶段 B：export class InternalError extends Error {}（随 Repository 引入，不 throw，放 res.error）
```

**每方法专属 `XXXXResult`**（拒绝泛型；Go/Node 同名同构；`error` 字段是领域错误对象，`null` = 成功；Node **不 throw**）。**双结构**：
- **`record.Record`（领域 = 对外 JSON 形状）**：`happened_at` 带区串、tags 数组、无隐列——业务层/响应；本系统时间轴操作全在 Repository SQL 内，业务层只消费带区串。
- **`record.DBRow`（数据库直接映射）**：`HappenedAt time.Time` + `UtcOffset` + `Tags string`（DB JSON 字符串）——写路径入参 / Scan 产物；业务层 parse 请求的产物（time.Time + offset）直接填充，**零字符串往返**；SQL 直接消费。
- 转换仅一处：`FromDB(DBRow) → Record`（瞬间 + 隐列 → 带区串；tags JSON → 数组），Repository 读路径调用。

```go
type RecordFindByIDResult struct {
	OK     bool
	Record record.Record // 领域 = 对外形状：HappenedAt 带区串；隐列在 DBRow
	Error  error         // 领域哨兵；nil = 成功
}
// Save(ctx, row record.DBRow) RecordSaveResult —— 写路径收 DB 映射，返回领域 Record（FromDB）
```
```ts
export type RecordFindByIDResult = {
	ok: boolean
	record: Record | null // 领域 = 对外形状：happened_at 带区串
	error: Error | null   // 领域错误实例；null = 成功
}
// save(row: DBRow) → Promise<RecordSaveResult> —— 写路径收 DB 映射，返回领域 Record（fromDB）
```

**status 映射**（业务层，A2 风格）：先 `err == nil` 快速返回成功；`switch errors.Is(err, ...)`（Node `instanceof`）；`default` = 未知错误 = 漏了 case 需补代码（暂 500 并留注释）。**400 校验错误发生在事务外（零 DB）**，直接给 status，无需领域分类。

## 5. Repository 方法签名表（构造注入执行器；`New(q db.Executor)` / `new RecordRepository(q)`）

| # | 方法 | Go | Node | 说明（定案） |
|---|---|---|---|---|
| 1 | `save` | `Save(ctx, rec) RecordSaveResult` | `save(rec) → Promise<RecordSaveResult>` | 单条 INSERT，RETURNING 完整行 |
| 2 | `saveAll` | `SaveAll(ctx, recs) RecordSaveAllResult` | `saveAll(recs) → Promise<RecordSaveAllResult>` | number/transaction 批量，事务内 |
| 3 | `upsert` | `Upsert(ctx, recs) RecordUpsertResult` | `upsert(recs) → Promise<RecordUpsertResult>` | `INSERT ... ON CONFLICT (id) DO UPDATE` 全字段（D2）；**batch 内重复 id 检测在业务层**；返回 `record.UpsertCounts`（待定点 4：移 `record` 包，否则 recordrepo↔importapi 循环） |
| 4 | `findById` | `FindByID(ctx, id) RecordFindByIDResult` | `findById(id) → Promise<RecordFindByIDResult>` | 未找到 → `record.ErrNotFound` |
| 5 | `findByCriteria` | `FindByCriteria(ctx, c) RecordFindByCriteriaResult` | `findByCriteria(c) → Promise<...>` | **只返回 records**；`total` 由业务层再 `Count(q, c)`（待定点 1：方案 B，读路径无事务，默认 READ COMMITTED 下两次独立查询可接受） |
| 6 | `findByCursor` | `FindByCursor(ctx, from, limit) RecordFindByCursorResult` | 同左 | export 游标（待定点 2：`findInRange` **移除**——summary 无区间参数用 `count`，export 是 id 游标）。无 from → 全表 id ASC LIMIT；有 from → 先 EXISTS 检查（不存在 → `fmt.Errorf("export from id not found: %w", ErrNotFound)`）再 `id >= from` ASC LIMIT |
| 7 | `count` | `Count(ctx, c) RecordCountResult` | 同左 | stats total/today；summary 覆盖 |
| 8 | `countTags` | `CountTags(ctx, prefix) RecordCountTagsResult` | 同左 | 返回 `[]tags.TagCount` |
| 9 | `attachTag` | `AttachTag(ctx, rec, tag) RecordAttachTagResult` | 同左 | **CAS**（WHERE 含旧 tags）；`rec` 自带旧 tags（业务层 `findById` 预读）；返回新 record，业务层 diff 得 `changed` |
| 10 | `detachTag` | `DetachTag(ctx, rec, tag) RecordDetachTagResult` | 同左 | 同上 |
| 11 | `transition` | `Transition(ctx, id, tags []string) RecordTransitionResult` | 同左 | **只 UPDATE tags**（A5：领域服务编排 + Repository 原语）；`RowsAffected != 1` → 内部错误（阶段 B 用 `ErrInternal`）；审计行 INSERT **复用 `save`** |
| 12 | `renameTag` | `RenameTag(ctx, from, to) RecordRenameTagResult` | 同左 | 全表改名，事务内 |

- 方法第一个参数一律是构造注入的 `Executor`（无「有的收 pool 有的收 tx」割裂）；Go PascalCase / Node camelCase，**词干一致**。
- 复合领域操作（saveAll / upsert / attachTag / detachTag / transition / renameTag）由业务层 `s.uow.Do` 包裹，Repository 内不出现 `Begin`/`Commit`。
- todo 变形、summary 聚合等**领域逻辑留在业务层**，Repository 只读写原始行；tags 保留前缀 / 合法性校验在**业务层零 DB**。

## 6. Criteria（D1 定案）

`recordrepo.Criteria`（Node `Criteria`）= 原 `ParsedQuery` **去掉 `Hint`**：

```go
type Criteria struct {
	ID        string      // 空 = 无 id 过滤
	From, To  *time.Time  // happened_at 区间（含 utc_offset 语义）
	Tags      []string    // 每项精确 tag 或 "family:*" 族通配；空 = 无 tag 过滤
	Q         string      // 全文搜索 raw_content / objective_context / ai_analysis / tags
	Page      int
	PageSize  int
	SortBy    string      // happened_at | id
	SortOrder string      // asc | desc
}
```

- **`hint` 不进 Criteria**（响应辅助，业务层 parse 时产出、随响应返回）。
- **校验归属**：现有 `ParseRecordQueryParams`（双端）保留在业务层，产出**已校验**的 `Criteria`；Repository 不重复校验。
- **条件构建在 Repository 内部**（D3：Go raw SQL / Node drizzle builder，双端不强制 SQL 同构，只保证行为一致；`EscapeLikePattern`、族通配判定、`recordsOrderBySql` 迁入 Repository 层，避免 query↔recordrepo 循环）。

## 7. 包布局（B1 / B2 定案）

**Go（无环）**：
```
db        Executor / Tx / TxBeginner / UoW（替换 db.Querier）
record    Record / 领域错误（ErrNotFound/ErrConflict，阶段 B 加 ErrInternal）/ UpsertCounts
tags      TagCount / AggregateTagCounts
recordrepo RecordRepository / Criteria / XXXXResult  → db, record, tags
logapi/importapi/exportapi/query/httpx（业务层）      → recordrepo, db, record
```

**Node**：
```
src/db/index.ts        drizzle 单例
src/db/schema.ts       Drizzle schema
src/db/uow.ts          Executor / DbTransaction / UoW class
src/lib/record.ts      领域类型 + 领域错误类（阶段 B 加 InternalError）
src/lib/recordrepo.ts  RecordRepository / Criteria / XXXXResult
src/lib/logapi.ts 等   业务层（Service class）
```

## 8. 测试机制（C2 定案）

- **Go**：fake `Executor`（断言 SQL）/ fake `TxBeginner`（回滚测试：`failOn` 第 N 次调用注入错误 → 断言全部回滚 + 500）；Service 单测注入 fake `db.UoW`。
- **Node**：`vi.mock('@/db')` 手工 mock drizzle builder 链 + fake `transaction`；**回滚测试模式** = fake executor 某操作 `mockRejectedValueOnce` → `uow.do` 整体 reject → 500、无成功半状态（`logapi.transition.test.ts` 先例）。log/numbers `SaveAll` 回滚测试（继承项 2）照此编写。

## 9. 双端对照

| 环节 | Go | Node |
|---|---|---|
| 执行器 | `Executor`（+ `Tx` / `TxBeginner`） | `Executor = PostgresJsDatabase<typeof schema> \| DbTransaction`（无 Tx/TxBeginner——drizzle 已封装事务边界） |
| UoW | `db.UoW`，`Do(ctx, fn(q Executor))` | `UoW` class，`do(fn(q: Executor))`（包装 `db.transaction`） |
| 事务边界 | **Service 方法内部**（业务层决定用不用事务） | 同左（模块级 db 单例） |
| Service | struct + 方法，构造注入 `db` + `uow` | class + 方法，构造注入 `db` + `uow` |
| Repository | `recordrepo.New(q)` 每次现构建 | `new RecordRepository(q)` 每次现构建 |
| 执行器来源 | 构造注入（Go 接口） | 全局 `db` 单例（`vi.mock` 模块） |
| 测试 | fake Executor / TxBeginner / UoW | `vi.mock('@/db')` |

**行为同构（事务边界在业务层、repo 构造注入执行器、领域错误 + XXXXResult、预读位置按语义）**；注入机制差异（Go 接口 / Node 模块 mock）为框架差异，非不一致。

## 10. 迁移步骤（E1 定案：逐个迁移、每步全绿提交）

1. **定义接口**：Go `db` 包 `Executor`/`Tx`/`TxBeginner` + `UoW.Do`；Node `src/db/uow.ts`（`Executor`/`UoW` class）。✅ 已完成（`602a41e`）
2. **统一散落接口**：`rowQuerier` / `transitionDB` / `db.Querier` → `Executor`（纯重构，不改变行为）。✅ 已完成（`5486488` + `fcd93df`）
3. **迁移 transition**（最小先例）：`transitionTodo` 走 `db.WithTx` + `recordrepo.Transition`/`Save`/`FindByID` 原语，fake 单测。✅ 已完成（`6c6607c`）——**暂用函数形态 `db.WithTx(ctx, q, fn)`**（Service 结构体未引入；`UoW.Do` 即 `WithTx` 的注入封装，行为一致）
4. **迁移批量 create**（number/transaction）：`SaveAll` → **补 log/numbers 回滚测试**（继承项 2）。✅ 已完成（`SaveAll` 循环复用 `Save` 单条原语；业务层 `db.WithTx`/`UoW.do` + `SaveAll`，无手写 Begin/Commit；回滚测试：Go `number_rollback_test.go` fakeTx failOn 第 2 条 INSERT 注入错误 → 500/回滚/无半状态；Node `logapi.number-rollback.test.ts` `mockRejectedValueOnce` 同语义）。
5. **迁移单条 create**（text/todo/bodyWeight/review）：`Save`（无事务）。
6. **迁移 import / rename**：`Upsert` / `RenameTag`（事务）；`UpsertCounts` 移 `record` 包。
7. **tags 增删接口**（新接口，暂停中）：`AttachTag` / `DetachTag`（CAS）——业务层零 DB 校验 → `uow.Do` → Repository 存在性/重复性/CAS（见 `docs/20260805-tags-add.md`）。
8. **迁移读路径**（query/export/stats/summary/tags）：`FindByCriteria` / `FindByCursor` / `Count` / `CountTags`（fake executor 单测查询条件）。
9. **Service 化（横切，2026-08-06 补充）**：业务层自由函数（logapi/importapi/exportapi/query）→ **Service struct/class 方法**，构造注入 `db` + `uow`；`db.WithTx(ctx, q, fn)` → `s.uow.Do(ctx, fn)`（Node `new UoW(db)` → 构造注入 `this.uow`）；httpx/route 装配注入 Service；测试改注入 fake uow。双端对称，一次性横切。
10. **回归**：全量 unit + integration + lint（`npm run test:unit`、`npm run test:integration`、`go build/vet/golangci-lint`、`npm run openapi:lint`）。

## 11. 阶段 B（ErrInternal 防腐层，随 UoW 落地）

Repository 吸收三方库错误为 `record.ErrInternal`（Unwrap 保链）；`writeInternalError`/`writeLogOrError` 删除，handler 统一 `logResponseError(status, logMsg, err)` + `writeError(w, status, errorDetail(err))`（阶段 A 的 `errorDetail`/`errorMessage` 已先行落地）。细节见 [`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md)。

## 12. 相关记录

- tags 增删接口（首个采用本架构的新接口）：[`docs/20260805-tags-add.md`](20260805-tags-add.md)。
- 内部错误透传（阶段 A 已完成 + 阶段 B）：[`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md)。
- Go 代码质量规范（错误链 / ST1005 / 日志）：[`docs/20260805-go-code-quality.md`](20260805-go-code-quality.md)。
- 审查过程与历次模型修订（X/Y/Service 形态演进）：git history（`20260805-repository-architecture-review.md` 各定案 commit，文件已删）。
