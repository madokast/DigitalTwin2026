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
| **Repository**（`RecordRepository`） | 领域语义持久化方法（非 SQL 透传）；存在性 / 重复性 / 并发（CAS）；**不管理事务** | **方法收执行器 `q`**（`Executor` 参数） |
| **Executor** | DB 访问句柄：Go `*pgxpool.Pool` / `pgx.Tx` 均满足；Node drizzle `db` / 事务 `tx` 均满足 | — |
| **UnitOfWork（UoW）** | 事务边界：`begin / rollback / commit` 机制封装 | 构造注入的事务起点 |

- **业务层不得直接发 SQL**——写路径与读路径全部经 `RecordRepository`（Service 持有的 `db` 仅作执行器源传给 repo / UoW）。
- **UoW 在业务层，不在 Repository**（DDD 规范：事务边界是 UoW 的职责）。**硬约束：Repository 内禁止开事务**——方法只消费**传入的执行器参数 `q`**（业务层 UoW 传入的 tx 或非事务 pool），绝不调用 `Begin`/`Commit`/`Rollback`；业务层需多方法同事务时，在 `uow.Do` 闭包内用同一个 `q`（= tx）依次调用 repo 方法，原子性由业务层这一个事务保证。
- **业务函数错误 = 带 status 的 error**（`StatusError`，见 §4）——业务函数返回 `(T, error)`，handler `errors.As` 取 status；不再用 `(T, status, error)` 元组。

## 2. 形态（双端一致，2026-08-06 定案 + 修订）

**Service 结构体 / class + 依赖注入**；**Repository 空结构体 + 单例 `Repo`，方法显式收执行器 `q`**；**事务边界在 Service 方法内部**（UoW 封装机制）；**业务函数收 typed 请求体、返回 `(T, error)`**（错误带 status，§4）。

```go
// Go（faas/internal/logapi/service.go 等）
type Service struct {
	db  *pgxpool.Pool // 执行器源（单条路径直接当 Executor 传 repo）
	uow *db.UoW       // 事务源
}

// 单条（无事务）：pool 当执行器传给 Repo 方法
func (s *Service) GetUser(ctx context.Context, req GetUserRequest) (*User, error) {
	res := recordrepo.Repo.FindByID(ctx, s.db, req.ID)   // ← q 显式传参
	if !res.OK {
		return nil, statusError(http.StatusNotFound, res.Error)  // 领域错误 → 带 status
	}
	return res.User, nil
}

// 多语句（事务）：UoW 包，闭包内 q = tx
func (s *Service) Transfer(ctx context.Context, req TransferRequest) error {
	return s.uow.Do(ctx, func(q db.Executor) error {
		if err := recordrepo.Repo.Transition(ctx, q, req.FromID, req.Tags); err != nil {
			return err
		}
		return recordrepo.Repo.Save(ctx, q, req.Audit)  // ← 同一个 q = tx
	})
}
```

```ts
// Node（src/lib/service.ts）
class Service {
  constructor(private db: Db, private uow: UoW) {}

  // 单条（无事务）：db 当执行器传 Repo 方法
  async getUser(req: GetUserRequest): Promise<User | null> {
    const res = await recordrepo.Repo.findById(this.db, req.id)
    if (!res.ok) throw new StatusError(httpStatus.NOT_FOUND, res.error)
    return res.record
  }

  // 多语句（事务）
  async transfer(req: TransferRequest): Promise<void> {
    return this.uow.do(async (q) => {
      await recordrepo.Repo.transition(q, req.fromID, req.tags)
      await recordrepo.Repo.save(q, req.audit)  // ← 同一个 q = tx
    })
  }
}
```

**要点**：
- **Repository 空结构体 + 单例 `Repo`（Go `var Repo = &RecordRepository{}` / TS `export const Repo = new RecordRepository()`），方法第一参数一律显式收执行器 `q`**（`recordrepo.Repo.Save(ctx, q, rec)`；WithTx 下 `recordrepo.Repo.Save(ctx, tx, rec)`）——不构造注入、不每次 `New(q)`。
- **业务函数收 typed 请求体**（`GetUserRequest` 等，双端同构），Go 不再收 `raw []byte`（对齐 Node typed body）。
- Service 方法内部决定「用不用事务」：单条直接传 `s.db`；多语句 `s.uow.Do` 包，闭包内传 `tx`（两者都满足 `Executor`）。
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

**每方法专属 `XXXXResult`**（拒绝泛型；Go/Node 同名同构；`error` 字段是领域错误对象，`null` = 成功；Node **不 throw**）。**单一领域形态 `record.Record`**（领域 = 对外 JSON 形状：`happened_at` 带区串、tags 数组）——Repository 返回、业务层构造写意图、消费输出；`record.DBRow` 为**数据库直接映射（仅 Repository 内部**：FromDB 入参 / Scan 产物），业务层禁止接触。

**happened_at 处理原则（写路径，2026-08-06 修订）**：业务层只 `ValidateHappenedAt(raw) error`（校验，零 DB，400）→ 构造 `record.Record`（`HappenedAt` 为已校验的请求串，作写入意图）→ `Save(ctx, q, rec)`；Repository 内部 `ParseHappenedAt(rec.HappenedAt)` 落库（time + utc_offset）→ RETURNING → `FromDB`（规范化）→ **返回规范化 `Record`**。业务层后续（响应、后续处理）**一律用返回值，绝不用传入的 happened_at**。**接受两次解析成本**（业务层 `ValidateHappenedAt` 校验解析 + Repository 内 `ParseHappenedAt` 落库）——换取单一 `Record` 形态（无 NewRecord / DateTimeWithOffset 双类型）。

```go
type RecordFindByIDResult struct {
	OK     bool
	Record record.Record // 领域 = 对外形状：HappenedAt 带区串（规范化）
	Error  error         // 领域哨兵；nil = 成功
}
// Save(ctx, q, rec record.Record) RecordSaveResult —— 写路径收领域对象，返回规范化 Record（FromDB）
// draft.ValidateHappenedAt(raw) error —— 业务层唯一 happened_at 校验入口（不产 time/offset）
```
```ts
export type RecordFindByIDResult = {
	ok: boolean
	record: Record | null // 领域 = 对外形状：happened_at 带区串（规范化）
	error: Error | null   // 领域错误实例；null = 成功
}
// save(q, rec: Record) → Promise<RecordSaveResult> —— 写路径收领域对象，返回规范化 Record（fromDB）
```

**业务函数错误 = 带 status 的 error（`StatusError`，2026-08-06 定案，替代 `(T, status, error)` 元组）**：

```go
// record 包或 httpx 层
type StatusError struct {
	Status int
	Err    error
}
func (e *StatusError) Error() string { return e.Err.Error() }
func (e *StatusError) Unwrap() error { return e.Err }

// 业务函数返回 (T, error)，status 由错误携带：
func (s *Service) GetUser(ctx context.Context, req GetUserRequest) (*User, error) {
	res := recordrepo.FindByID(ctx, s.db, req.ID)
	if !res.OK {
		switch {
		case errors.Is(res.Error, record.ErrNotFound):
			return nil, statusError(http.StatusNotFound, res.Error)   // 带 status 的错误
		default:
			return nil, statusError(http.StatusInternalServerError, res.Error) // 漏了 case 需补代码
		}
	}
	return res.User, nil
}
// handler：errors.As(err, &se) 取 se.Status
```

- **400 校验错误发生在事务外（零 DB）**：`ValidateHappenedAt` / 字段校验失败 → `statusError(400, err)`，无需领域分类。
- **status 来源**：领域错误（ErrNotFound→404 等）由业务层 `errors.Is`（Node `instanceof`）映射为 `StatusError`；透传的驱动错误（500）包成 `StatusError{500, err}`（阶段 B 用 `ErrInternal` 领域化）。
- `default` = 未知错误 = 漏了 case 需补代码（暂 500 并留注释）。

## 5. Repository 方法签名表（**空结构体 + 单例 `Repo`，方法第一参数一律收执行器 `q`**）

| # | 方法 | Go | Node | 说明（定案） |
|---|---|---|---|---|
| 1 | `save` | `Save(ctx, q, rec record.Record) RecordSaveResult` | `save(q, rec: Record) → Promise<RecordSaveResult>` | 单条 INSERT，RETURNING 完整行；Repository 内 `ParseHappenedAt(rec.HappenedAt)` 落库，返回规范化 Record |
| 2 | `saveAll` | `SaveAll(ctx, q, recs []record.Record) RecordSaveAllResult` | `saveAll(q, recs: Record[]) → Promise<RecordSaveAllResult>` | number/transaction 批量，事务内 |
| 3 | `upsert` | `Upsert(ctx, q, recs) RecordUpsertResult` | `upsert(q, recs) → Promise<RecordUpsertResult>` | `INSERT ... ON CONFLICT (id) DO UPDATE` 全字段（D2）；**batch 内重复 id 检测在业务层**；返回 `record.UpsertCounts`（移 `record` 包，否则 recordrepo↔importapi 循环） |
| 4 | `findById` | `FindByID(ctx, q, id) RecordFindByIDResult` | `findById(q, id) → Promise<RecordFindByIDResult>` | 未找到 → `record.ErrNotFound` |
| 5 | `findByCriteria` | `FindByCriteria(ctx, q, c) RecordFindByCriteriaResult` | `findByCriteria(q, c) → Promise<...>` | **只返回 records**；`total` 由业务层再 `Count(q, c)`（方案 B，读路径无事务） |
| 6 | `findByCursor` | `FindByCursor(ctx, q, from, limit) RecordFindByCursorResult` | 同左 | export 游标（`findInRange` **移除**）。无 from → 全表 id ASC LIMIT；有 from → 先 EXISTS 检查（不存在 → `fmt.Errorf("export from id not found: %w", ErrNotFound)`）再 `id >= from` ASC LIMIT |
| 7 | `count` | `Count(ctx, q, c) RecordCountResult` | 同左 | stats total/today；summary 覆盖 |
| 8 | `countTags` | `CountTags(ctx, q, prefix) RecordCountTagsResult` | 同左 | 返回 `[]tags.TagCount` |
| 9 | `attachTag` | `AttachTag(ctx, q, rec, tag) RecordAttachTagResult` | 同左 | **CAS**（WHERE 含旧 tags）；`rec` 自带旧 tags（业务层 `FindByID` 预读）；返回新 record，业务层 diff 得 `changed` |
| 10 | `detachTag` | `DetachTag(ctx, q, rec, tag) RecordDetachTagResult` | 同左 | 同上 |
| 11 | `transition` | `Transition(ctx, q, id, tags []string) RecordTransitionResult` | 同左 | **只 UPDATE tags**（A5：领域服务编排 + Repository 原语）；`RowsAffected != 1` → 内部错误（阶段 B 用 `ErrInternal`）；审计行 INSERT **复用 `save`** |
| 12 | `renameTag` | `RenameTag(ctx, q, from, to) RecordRenameTagResult` | 同左 | 全表改名，事务内 |

- **第一参数一律是执行器 `q`**（非事务 `pool` / `db`，或事务 `tx`——无「有的收 pool 有的收 tx」割裂）；方法挂在包级单例 `Repo` 上（Go `recordrepo.Repo.Save(ctx, q, ...)` / TS `Repo.save(q, ...)`）；Go PascalCase / Node camelCase，**词干一致**。
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
| Repository | **空结构体 + 包级单例 `Repo`，方法第一参数收执行器 `q`** | **空结构体 + 模块级单例 `Repo`，方法第一参数收执行器 `q`** |
| 业务函数入参 | **typed 请求体**（对齐 Node） | typed 请求体 |
| 业务函数返回 | `(T, error)`，status 由 `StatusError` 携带 | `Promise<(T, StatusError)>` 或 throw StatusError |
| 执行器来源 | 调用方传参（Go 接口） | 调用方传参（模块 mock） |
| 测试 | fake Executor / TxBeginner / UoW | `vi.mock('@/db')` |

**行为同构（事务边界在业务层、repo 单例方法显式收执行器参数、领域错误 + XXXXResult、StatusError 错误、typed 入参、预读位置按语义）**；注入机制差异（Go 接口 / Node 模块 mock）为框架差异，非不一致。

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

## 10a. 形态修订（2026-08-06 定案，A/B 已实施，C/D 待落地）

- **A. Repository 形态 → 空结构体 + 单例 `Repo`，方法第一参数收执行器 `q`**（✅ 已实施 `0d52f1b`）：`recordrepo.Repo.Save(ctx, q, rec)` / WithTx 下 `recordrepo.Repo.Save(ctx, tx, rec)`；删除 `recordrepo.New(q)` 构造注入与每次现构建（Go `var Repo = &RecordRepository{}` / TS `export const Repo = new RecordRepository()`）。业界主流（方法收执行器 + 单例，sqlc 教程派）。
- **B. happened_at 简化 → 单一 `Record` 形态**（✅ 已实施，本 commit）：删除 `NewRecord` / `DateTimeWithOffset` / `NormalizeHappenedAt`；业务层 `ValidateHappenedAt(raw) error`（校验）→ 构造 `record.Record`（`HappenedAt` 为已校验请求串，各 draft 产物暴露 `HappenedAtRaw`）→ `Save(ctx, q, rec)`；Repository 内 `ParseHappenedAt` 落库 → 返回规范化 `Record`；业务层只用返回值。**接受两次解析成本**（业务层校验解析 + Repository 落库解析），换取无双类型。
- **C. Go 业务函数入参 → typed 请求体**（待实施）：`CreateText(ctx, pool, raw []byte)` → `CreateText(ctx, pool, body TextBody)`（typed 结构体，对齐 Node typed body）；双端请求结构同构。
- **D. 业务函数错误 → 带 status 的 error**（待实施）：`(T, status, error)` 元组 → `(T, error)` + `StatusError{Status, Err}`（`errors.As` 取 status，Node `StatusError` class）；handler 统一映射。

> 注：A/B 已按终稿形态落地；剩余过渡形态（`(T, status, error)` 元组 + Go 收 `[]byte`）随 C/D 落地统一。

## 11. 阶段 B（ErrInternal 防腐层，随 UoW 落地）

Repository 吸收三方库错误为 `record.ErrInternal`（Unwrap 保链）；`writeInternalError`/`writeLogOrError` 删除，handler 统一 `logResponseError(status, logMsg, err)` + `writeError(w, status, errorDetail(err))`（阶段 A 的 `errorDetail`/`errorMessage` 已先行落地）。细节见 [`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md)。

## 12. 相关记录

- tags 增删接口（首个采用本架构的新接口）：[`docs/20260805-tags-add.md`](20260805-tags-add.md)。
- 内部错误透传（阶段 A 已完成 + 阶段 B）：[`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md)。
- Go 代码质量规范（错误链 / ST1005 / 日志）：[`docs/20260805-go-code-quality.md`](20260805-go-code-quality.md)。
- 审查过程与历次模型修订（X/Y/Service 形态演进）：git history（`20260805-repository-architecture-review.md` 各定案 commit，文件已删）。
