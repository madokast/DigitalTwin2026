# UoW + Repository 架构定案

> 创建日期：2026-08-05
> 性质：架构定案文档。业务层与数据库隔离采用 **UnitOfWork + Repository** 模式（DDD 规划，业界常识），双端（Next/Go）同构。
> 触发：`log/numbers` 批量验收第 5 项（事务原子性）时发现业务层直接耦合 `*pgxpool.Pool` 无法 mock DB 测回滚；后 tags 增删接口（`docs/20260805-tags-add.md`）定案采用本架构。
> 取代：`20260805-repository-abstraction.md`（已删除，方案 A/B/C 框架被本架构取代；有效信息见「继承」节）。

## 领域模型：唯一聚合根 Record

- **数据库只有一张 `records` 表**（Drizzle schema 仅 `records`；Go 全部 SQL 均在 records 上）。tags 为 JSON 数组列。
- Number / Text / Todo / Review / Transaction / BodyWeight **都是 Record 的 tag 变体**（`todo:in_progress`、`transaction_entry:income`、`review:weekly`…），非独立表。
- **唯一聚合根 = Record** → **唯一 Repository = `RecordRepository`**（命名单数，DDD 惯例：`UserRepository` / `OrderRepository`；且复数化只作用于 API 端点资源空间，内部类型一律单数——`numberdraft`、`ParseNumberBatch` 先例）。
- Todo / Transaction 等不是独立聚合——它们是 Record 上的操作，由**领域服务**承载（如 `TransitionService`），复用 `RecordRepository`。
- **dbprobe 排除**：基础设施健康检查（独立连接 + `select 1` + records 表存在性），非领域查询，不进 Repository（测试策略独立）。

## 架构分层（定案）

| 层 | 职责 | 依赖 |
|---|---|---|
| 业务层（draft / handler / 领域服务） | 参数解析与校验（**零 DB**）；**经 UoW 开事务**；编排领域操作；组织响应 | `Executor` / `UoW` / `RecordRepository` |
| **Repository**（`RecordRepository`） | 领域语义持久化方法（非 SQL 透传）；存在性 / 重复性 / 并发（CAS）判断；**不管理事务** | `Executor` |
| **Executor** | DB 访问句柄：Go `*pgxpool.Pool` 与 `pgx.Tx` 均满足；Node drizzle `db` 与事务 `tx` 均满足 | — |
| **UnitOfWork** | 事务边界：Go 函数式 `WithTx`；Node `db.transaction` | — |

- **业务层不得**直接依赖第三方 DB 类型（Go：`*pgxpool.Pool`；Node：`@/db` 单例）——写路径与读路径**全部**经 `RecordRepository`。
- **接口注入使单测可假实现**（Go fake Executor；Node 注入 fake executor），从而可测「事务失败回滚」「SQL 断言」「查询条件」。
- **UoW 在业务层，不在 Repository**（DDD 规范：事务边界是 UnitOfWork 的职责）。Repository 方法统一收 `Executor`（事务内外同一个签名），无「有的收 pool 有的收 tx」的割裂。

## Executor（统一，取代散落接口）

- Go：统一接口取代散落的 `rowQuerier`（log.go）、`transitionDB`（todo.go）、`db.Querier`（tags.go）：

```go
type Executor interface {
    QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
    Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
    Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
```

- Node：drizzle `db` 与事务 `tx` 天然是同一形状的「执行器」（`insert`/`update`/`select`/`execute`），无需额外包装；以类型约束对齐 Go 的方法集。

## Repository 方法集（DDD 命名，双端对齐）

方法第一个参数一律是 `Executor`（Go `ctx, q, ...` / Node `q, ...`）；Go PascalCase、Node camelCase，**词干一致**。

| 领域操作 | DDD 命名 | Go / Node |
|---|---|---|
| 单条 create（text/todo/bodyWeight/review） | `save` | `Save(ctx, q, record)` / `save(q, record)` |
| 批量 create（number/transaction batch，UoW 内） | `saveAll` | `SaveAll(ctx, q, records)` / `saveAll(q, records)` |
| import（insert-or-update，UoW 内） | `upsert` | `Upsert(ctx, q, records)` / `upsert(q, records)` |
| 按 id 查（tags 增删 / transition 预读） | `findById` | `FindByID(ctx, q, id)` / `findById(q, id)` |
| 条件查询（query 端点） | `findByCriteria` | `FindByCriteria(ctx, q, criteria)` / `findByCriteria(q, criteria)` |
| 区间读（summary / export） | `findInRange` | `FindInRange(ctx, q, from, to, criteria)` / `findInRange(q, from, to, criteria)` |
| 计数（records/stats） | `count` | `Count(ctx, q, criteria)` / `count(q, criteria)` |
| tags 计数（tags 端点） | `countTags` | `CountTags(ctx, q, prefix)` / `countTags(q, prefix)` |
| tags 附加（CAS，UoW 内） | `attachTag` | `AttachTag(ctx, q, id, tag)` / `attachTag(q, id, tag)` |
| tags 分离（CAS，UoW 内） | `detachTag` | `DetachTag(ctx, q, id, tag)` / `detachTag(q, id, tag)` |
| todo 流转（双写，UoW 内） | `transition` | `Transition(ctx, q, id, target)` / `transition(q, id, target)` |
| 全表改名（UoW 内） | `renameTag` | `RenameTag(ctx, q, from, to)` / `renameTag(q, from, to)` |

**规范**：
- 聚合根名词单数（`findById` 非 `findByIds`——返回单条）。
- 复合领域操作（transition / attachTag / detachTag / renameTag / saveAll / upsert）由业务层 `WithTx` 包裹，Repository 内不出现 `Begin`/`Commit`。
- todo 变形、summary 聚合等**领域逻辑留在业务层 / 领域服务**，Repository 只读写原始行。
- tags 的保留前缀 / 合法性校验在**业务层零 DB** 完成（`isValidTag` / `reservedTagError`），Repository 只处理存在性（404）、重复性（changed:false）、CAS 并发。

## Criteria 抽象

读方法的条件参数（tag 精确 / 族通配 `X:*`、id、from/to、sort、limit、page_size）建模为**纯数据对象**（无 SQL），Repository 内映射为 WHERE：

- Go：`Criteria` struct（字段与查询参数对齐）
- Node：`Criteria` type（同字段）

两端字段名一致（snake_case 与现有契约对齐）；Repository 内构造 SQL / LIKE 转义（`EscapeLikePattern` 等留在 Repository 或共享 util）。

## UoW 形态（定案）

- **Go**：函数式 `WithTx(ctx, pool *pgxpool.Pool, fn func(q Executor) error) error`——内部 `Begin` / `defer Rollback` / 回调成功 `Commit`。`pool` 与 `fn` 收到的 `q` 均满足 `Executor`。
- **Node**：`withTx(db, async (tx) => { ... })`——包装 `db.transaction`；`tx` 满足执行器形状。
- 业务层只在需要事务的操作外包 `WithTx`；只读方法直接传 pool/`db` 执行器。

## 继承（已删除的 20260805-repository-abstraction.md）

1. **`transitionDB` 先例**：`faas/internal/logapi/todo.go` 已用最小接口注入（`transitionDB{QueryRow; Begin}` + `transitionTx`，`poolAdapter` 包装 pool，`todo_db_test.go` 假实现）——验证「接口注入可测事务回滚」可行；本架构将其泛化为统一 `Executor` + `WithTx`。
2. **log/numbers 回滚测试待办**：`CreateNumberBatch` 事务实现正确但**回滚测试缺失**（业务层耦合 pool 无法注入 fake）。本架构落地后补「第 N 次 insert 注入错误 → 全部回滚 → 500」（Go + Node 双端）。
3. **曾实现后回滚的经验**：方案 B 的 Go 接口改造（`db/querier.go` 加 `Tx`/`TxBeginner`、`CreateNumberBatch` 改签名、`number_rollback_test.go`）曾实现后回滚——**教训**：一次性大改造风险高，本架构按操作逐个迁移、每步保持测试全绿。

## 实施顺序（定案）

1. **定义接口**：Go `Executor` + `WithTx`（`faas/internal/db` 或 `recordrepo` 包）；Node `recordRepository` 执行器类型 + `withTx`。
2. **统一散落接口**：`rowQuerier` / `transitionDB` / `db.Querier` → `Executor`（纯重构，不改变行为）。
3. **迁移 transition**（最小先例，已有假实现测试）：`TransitionTodo` 走 `WithTx` + `Transition`，fake 单测。
4. **迁移批量 create**（number/transaction）：`WithTx` + `SaveAll` → **补 log/numbers 回滚测试**（继承项 2）。
5. **迁移单条 create**（text/todo/bodyWeight/review）：`Save`。
6. **迁移 import / rename**：`Upsert` / `RenameTag`（事务）。
7. **tags 增删接口**（新接口，**暂停中**）：`AttachTag` / `DetachTag`——业务层零 DB 校验 → `WithTx` → Repository 存在性/重复性/CAS → `TagsEditSuccess`（见 `docs/20260805-tags-add.md`）。
8. **迁移读路径**（query/export/stats/summary/tags）：`FindByCriteria` / `FindInRange` / `Count` / `CountTags`（fake executor 单测查询条件）。
9. **回归**：全量 unit + integration + lint。

## 相关记录

- tags 增删接口（首个采用本架构的新接口）：[`docs/20260805-tags-add.md`](20260805-tags-add.md)。
- 验收上下文：`docs/20260805-log-number-batch.md` 实现注意点第 5 条（事务原子性）。
- 现有散落接口：`rowQuerier`（`faas/internal/logapi/log.go`）、`transitionDB`（`faas/internal/logapi/todo.go`）、`db.Querier`（`faas/internal/db/querier.go`）。
- transition 现状：`faas/internal/logapi/todo.go`（接口注入先例）。
