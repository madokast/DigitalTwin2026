# UoW + Repository 架构落地前审查清单

> 创建日期：2026-08-05
> 性质：落地前全面审查记录。对 `docs/20260805-repository-architecture.md` 逐项审查，收集遗漏 / 内部矛盾 / 落地风险 / 未讨论清楚的问题。逐项沟通解决后更新「状态」，作为实施的前置。
> 参考实现现状：`faas/internal/db/querier.go`（`db.Querier`）、`faas/internal/logapi/todo.go`（`transitionDB`/`transitionTx`/`poolAdapter`，接口注入先例）、`faas/internal/logapi/log.go`（`rowQuerier`/`insertReturning`）、`src/db/index.ts`（drizzle 单例）、`src/lib/logapi.ts`（`db.transaction` 用法）、`docs/20260805-tags-add.md`（首个采用本架构的接口）。

## 判定规则

- 每项解决后更新「状态」并给出结论（不悬空）。
- 阻塞实施的核心问题标 **【阻塞】**；其余为待定细节。

## A. 核心未定（阻塞实施）

### A1【阻塞】`Executor` 缺 `Begin` → `WithTx` 无法 fake，回滚测试仍写不了
- 现状：文档 `Executor` 仅 `QueryRow / Exec / Query`；`WithTx(ctx, pool *pgxpool.Pool, fn)` 收**具体 pool 类型**。
- 问题：`WithTx` 要 fake（注入假事务测回滚），必须对「开事务」抽象化——pool 要作为 `TxBeginner` 接口注入。但 `Executor` 无 `Begin`，`WithTx` 又收具体 `*pgxpool.Pool`，单测无法替代事务起点。**核心动机（log/numbers 回滚测试）无法达成**。
- 参考：现有 `transitionDB{QueryRow; Begin}` + `poolAdapter` 正是把 `Begin` 抽象化（`todo_db_test.go` 假实现）——统一时须保留此能力。
- 待决：`Executor` 是否并入 `Begin`（成为 `TxBeginner`），或 `WithTx` 独立收 `TxBeginner` 接口。

### A2【阻塞】`WithTx` 的错误映射（回调返回 `error`，业务层需要 HTTP status）
- 现状：业务函数返回 `(T, status, error)`（如 `(Record, int, error)`）；`WithTx` 回调 `fn func(q Executor) error` 只有 error。
- 问题：事务内错误如何转 HTTP status？404 / 409 / 400 是业务语义，500 是事务失败。若 `WithTx` 只回 `error`，业务层拿不到 status。
- 待决：`WithTx` 签名是否 `func(q Executor) (int, error)`？或错误走 sentinel + 统一映射？

### A3【阻塞】Repository 方法签名 / 返回类型未定义
- 现状：方法集只有名称与入参（`Save(ctx, q, record)` 等），**无返回类型**。
- 问题：落地前必须定：`Save`/`SaveAll`/`Upsert` 返回什么（`record.Record` / `[]record.Record`？含 id 的完整行？）；`FindByID` 未找到返回什么错误（sentinel？）；`AttachTag`/`DetachTag` 返回什么（旧 tags + 新 tags？`changed`？）；`Count`/`CountTags` 返回 `int` / `[]tags.TagCount`；`FindInRange` 的分页 / 排序在哪层。
- 待决：逐方法定义双端签名。

### A4【阻塞】业务函数签名变更与接口注入点
- 现状：业务函数收 `*pgxpool.Pool`（`CreateTodo(ctx, pool, raw)`）；httpx 直接调用；transition 用 `TransitionTodo` 字段注入（httpx 层）。
- 问题：迁移后业务函数收 `Executor` 还是收 `pool` 内部 `WithTx`？httpx 层如何保持可注入（`TransitionTodo` 字段签名是否变）？写路径「业务层开 WithTx」与「业务函数收 Executor（上层已开事务）」两种形态取哪种？现有 `CreateTodo` 单条 INSERT 是否需要事务（无多语句，可无事务）？
- 待决：逐业务函数定签名 + httpx 注入点。

### A5【阻塞】transition 的领域服务 vs Repository 边界
- 现状：`transitionTodo` 一个函数包含：SELECT 预读 → 领域校验（审计行 / 四态识别 / already target）→ 组 notify/objCtx → UPDATE + INSERT 审计（事务）。
- 问题：方法集有 `Transition(ctx, q, id, target)`，文档又说「领域逻辑留在业务层/领域服务，Repository 只读写原始行」。那么：校验谁做？`Transition` 方法只做 UPDATE？审计 INSERT 谁做？`TransitionService` 与 `Transition` 方法的关系？
- 待决：transition 拆分为「领域服务编排 + Repository 原语（`transition` 只 UPDATE？`save` 插审计？）」还是 Repository 组合方法。

## B. 包布局与依赖

### B1【阻塞】Go 包位置（Executor / RecordRepository / Criteria）
- 问题：`Executor` 放 `db` 包（替换 `db.Querier`）还是新包？`RecordRepository` 新 `recordrepo` 包？`Criteria` 放 `recordrepo` 还是 `query` 包？`db` 包是否被业务层 import（现有 logapi import `db.Querier` 于 tags.go）？循环依赖风险（`recordrepo` → `record` + `tags`；`query` → `recordrepo`）。
- 待决：包结构图。

### B2 Node 文件布局
- 问题：`src/lib/recordrepo.ts`（Repository）？`withTx` 放哪？`Criteria` type 放哪？与 `query.ts` / `tagsdb.ts` 的关系。
- 待决：Node 文件结构。

## C. Node 类型与测试机制

### C1 withTx 与执行器类型约束
- 问题：drizzle `db`（PgDatabase）与 `tx`（PgTransaction）类型不同但方法集相同；`withTx(db, fn)` 中 `fn` 收到的 `q` 类型如何表达（泛型 `DbQueryable`？）；业务函数收执行器的 TS 类型怎么写。
- 待决：Node 类型方案。

### C2 Node 单测的 fake 注入机制
- 问题：Go 有接口注入先例；Node 现在单测靠 `vi.mock('@/db')`？事务回滚测试（继承项 2 双端）Node 侧如何 fake `db.transaction` 使其失败回滚？
- 待决：Node 测试注入方案。

## D. 方法细节

### D1 Criteria 字段集完整定义
- 问题：文档只列「tag / id / from-to / sort / limit / page_size」；现有 query 参数实际含 `tag`（精确 / 族通配 `X:*`）、`from`/`to`（happened_at 区间 + 时区）、`page`、`page_size`、`sort_by`、`sort_order`、`hint`。字段默认值 / 校验在哪层（现 `ParseRecordQueryParams`）。
- 待决：Criteria 字段清单 + 校验归属。

### D2 upsert（import）幂等 / 错误归属
- 问题：import 是 insert-or-update by id，含「batch 内重复 id → 400 `line 2: duplicate record id`」。此重复检测在业务层还是 Repository？`Upsert` 是否含冲突检测？
- 待决：import 拆分。

### D3 读路径 SQL 策略（双端是否同构）
- 问题：Go 全部 raw SQL；Node 现在用 drizzle query builder。Repository 双端「方法名对齐」但 SQL 实现策略是否要求同构？`EscapeLikePattern` 等共享 util 放哪？
- 待决：SQL 层策略。

## E. 风险确认

### E1 迁移顺序与每步全绿（已定案，确认执行）
- 继承项 3 教训：按操作逐个迁移、每步测试全绿。实施步骤 1-9 已列。确认按此执行，不做一次性大改造。

### E2 httpx 层签名保持
- 问题：httpx `Server.TransitionTodo` 字段（单测注入 fake 结果）签名 `func(ctx, pool, raw) (TransitionResult, int, error)`。transition 迁移后此字段签名是否保持？httpx 测试（`todo_transition_test.go`）与集成测试如何跟？
- 待决：httpx 注入点迁移策略。

## 相关记录

- 架构定案：[`docs/20260805-repository-architecture.md`](20260805-repository-architecture.md)
- 首个采用接口：[`docs/20260805-tags-add.md`](20260805-tags-add.md)
- 回滚测试待办：架构文档「继承」节第 2 条（log/numbers 回滚测试）
