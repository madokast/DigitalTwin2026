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
- 状态：✅ **已定案**——Go 拆三层接口：`Executor`（QueryRow/Exec/Query）+ `Tx`（+Commit/Rollback）+ `TxBeginner`（+Begin）；`WithTx(ctx, q TxBeginner, fn func(q Executor) error)` 闭包式 UoW（业务方零事务 API）；`Server.Pool` 字段由 `*pgxpool.Pool` 放宽为 `db.TxBeginner`（`NewServer` 仍收 `*pgxpool.Pool`，自动满足）；Node 侧 `Executor` type（与 Go 同名）+ `withTx(fn)` 薄包装 `db.transaction`（Node 无 Tx/TxBeginner——drizzle 已封装事务边界）。注入机制差异（Go 接口 / Node `vi.mock` 模块）为框架差异，非不一致。**分层强约束**：业务层禁止调用 `Executor` 的 SQL 方法，`Executor` 仅 Repository 内部使用，业务层只用领域方法（`repo.SaveAll(q, ...)`）。
- 完整代码参考：[`docs/20260805-uow-repository-reference.md`](20260805-uow-repository-reference.md)（接口定义 / 实际实现封装 / 业务层 / handler / 装配 / 双端 fake 与回滚测试）

### A2【阻塞】`WithTx` 的错误映射（回调返回 `error`，业务层需要 HTTP status）
- 现状：业务函数返回 `(T, status, error)`（如 `(Record, int, error)`）；`WithTx` 回调 `fn func(q Executor) error` 只有 error。
- 问题：事务内错误如何转 HTTP status？404 / 409 / 400 是业务语义，500 是事务失败。若 `WithTx` 只回 `error`，业务层拿不到 status。
- 待决：`WithTx` 签名是否 `func(q Executor) (int, error)`？或错误走 sentinel + 统一映射？
- 状态：✅ **已定案**——`WithTx` 保持纯事务机制（`fn func(q Executor) error`，**不含 HTTP**）；Repository 方法返回**领域错误**（`record.ErrNotFound` / `record.ErrConflict` 等）；**业务函数签名保持 `(T, status, error)`**（handler 不动），status 在业务函数闭包外 `switch errors.Is` 映射。400 校验错误发生在事务外（零 DB），直接 `return ..., 400, err`（现状不变，无需领域分类）。**错误处理风格约定**：先 `if err == nil` 快速返回成功；`switch` 所有 case 用 `errors.Is`；`default` = 未知错误 = 漏了 case 需补代码（暂映射 500 并留注释）。参考代码见 [`docs/20260805-uow-repository-reference.md`](20260805-uow-repository-reference.md)「领域错误映射」。

### A3【阻塞】Repository 方法签名 / 返回类型未定义
- 现状：方法集只有名称与入参（`Save(ctx, q, record)` 等），**无返回类型**。
- 问题：落地前必须定：`Save`/`SaveAll`/`Upsert` 返回什么（`record.Record` / `[]record.Record`？含 id 的完整行？）；`FindByID` 未找到返回什么错误（sentinel？）；`AttachTag`/`DetachTag` 返回什么（旧 tags + 新 tags？`changed`？）；`Count`/`CountTags` 返回 `int` / `[]tags.TagCount`；`FindInRange` 的分页 / 排序在哪层。
- 待决：逐方法定义双端签名。

**推荐签名表（基于现有实现，讨论中）**：

| # | 方法 | Go | Node | 现状基础 |
|---|---|---|---|---|
| 1 | `save` | `Save(ctx, q, rec) (record.Record, error)` | `save(q, rec) → Promise<Record>` | `insertReturning`（RETURNING 完整行） |
| 2 | `saveAll` | `SaveAll(ctx, q, recs) ([]record.Record, error)` | `saveAll(q, recs) → Promise<Record[]>` | number/transaction 批量 |
| 3 | `upsert` | `Upsert(ctx, q, recs) (record.UpsertCounts, error)` | `upsert(q, recs) → Promise<UpsertCounts>` | `ImportRecordsJSONLTx` 的 `Counts{Inserted,Updated,Total}`（待定点 4 定案：移 `record` 包） |
| 4 | `findById` | `FindByID(ctx, q, id) (record.Record, error)`，未找到 → `record.ErrNotFound` | `findById(q, id) → Promise<Record>` | transition 的 SELECT 预读 |
| 5 | `findByCriteria` | `FindByCriteria(ctx, q, c) ([]record.Record, error)` | `findByCriteria(q, c) → Promise<Record[]>` | `FetchFilteredRecords` |
| 6 | ~~`findInRange`~~ | ✅ 已移除（待定点 2 定案）：export 拆 `findByCursor(ctx, q, from, limit)`（`[]record.Record, error`）；summary 用 #7 `count` | 同左 | `FetchExportRecords` |
| 7 | `count` | `Count(ctx, q, c) (int, error)` | `count(q, c) → Promise<number>` | stats total/today |
| 8 | `countTags` | `CountTags(ctx, q, prefix) ([]tags.TagCount, error)` | `countTags(q, prefix) → Promise<TagCount[]>` | `FetchTagCounts` |
| 9 | `attachTag` | `AttachTag(ctx, q, rec, tag) (record.Record, error)` | `attachTag(q, rec, tag) → Promise<Record>` | tags-add 定案 CAS |
| 10 | `detachTag` | `DetachTag(ctx, q, rec, tag) (record.Record, error)` | `detachTag(q, rec, tag) → Promise<Record>` | tags-add 定案 |
| 11 | `transition` | ⏸ 依赖 A5（领域服务 vs Repository 边界） | 同左 | `transitionTodo` 双写 |
| 12 | `renameTag` | `RenameTag(ctx, q, from, to) (int, error)` | `renameTag(q, from, to) → Promise<number>` | `RenameAcrossRecords` |

**attachTag/detachTag 传 `record` 而非 `fromTags`**：CAS 需要 tags 旧值作 WHERE 条件——业务层 `FindByID` 读到的 `rec` 自带旧 tags；返回新 `record`，业务层 diff from/to 得 `changed`（tags-add 响应）。

**待定点（5 个，逐个讨论后更新状态）**：

1. **`findByCriteria` 的 total**：query 端点需 `total`（COUNT）。A) `findByCriteria` 内部 COUNT+SELECT 一次返回 `(records, total)`（现状单次函数）；B) 返回 records，业务层再 `count(c)` 两次调用（方法语义单一）。
   - 状态：✅ **已定案（方案 B）**——`FindByCriteria` 只返回 `[]record.Record`；业务层（query handler）再调 `Count(q, c)` 取 total（签名表 #5 保持）。**不需要事务**：query 读路径无写、无 UoW；默认 `READ COMMITTED` 下同一事务内两条语句也各取快照、不保证一致（要一致须 REPEATABLE READ）；分页 total 与当前页的轻微竞态业界普遍接受——保持现状直连 pool 两次独立查询。
2. **`findInRange` 语义模糊**：summary（happened_at 区间**计数**）与 export（**id 游标分页**）语义完全不同。是否拆成：summary 用 `count(criteria 带区间)`、export 用独立 `findByCursor(q, from, limit)`？`findInRange` 是否从方法集移除？
   - 状态：✅ **已定案**——**`findInRange` 从方法集移除**（两消费方均不匹配：summary 无区间参数，total=today=全表/今日 count；export 是 id 游标）。拆为：
     - summary → **`count(criteria)`（#7 已有）** 覆盖，无新增方法。
     - export → 新增 **`findByCursor(ctx, q, from string, limit int) ([]record.Record, error)`**：无 `from` → 全表 `ORDER BY id ASC LIMIT`；有 `from` → 先 `SELECT EXISTS` 检查（不存在 → `fmt.Errorf("export from id not found: %w", record.ErrNotFound)`，业务层 `errors.Is` → 404）+ `id >= from ORDER BY id ASC LIMIT`。现有 `ErrExportFromNotFound` 独立哨兵随之并入 `record.ErrNotFound`（`%w` 拼接保 message）。
     - 签名表 #6 移除，export 业务函数（`(recs, status, error)` 保持）内部调 `FindByCursor`。
   - 双端现状基础：`FetchExportRecords`（Go）/`fetchExportRecords`（Node）均为「EXISTS 检查 + 游标」两次查询。
3. **Node 领域错误表达**：Go 用 `record.ErrNotFound` sentinel + `errors.Is`；Node 对称方案 = throw 领域错误类 + `instanceof`（`RecordNotFoundError` / `RecordConflictError`），业务层 catch 分类——但改变 Node 现状「返回 Result 对象不 throw」惯例。是否引入？或 Node 用 `null` / Result？
- 状态：✅ **已定案**——error 字段承载**领域错误对象**（Go `error` 哨兵 / Node `Error` 实例，`null` = 成功），**非字符串**。DDD Error 一套（双端对称）：message 固定（`record not found`、`record tags changed concurrently, retry`）或运行时拼接（`fmt.Errorf("record %s not found: %w", id, record.ErrNotFound)` / `new RecordNotFoundError(\`record ${id} not found\`)`）。**Node 不 throw**——Repository 返回 `XXXXResult`，错误实例放 `res.error` 字段。Service 层判断：Go `errors.Is(res.Error, record.ErrNotFound)`、Node `res.error instanceof RecordNotFoundError` → 带 status，message 透传 detail。每方法专属 `XXXXResult`（拒绝泛型，Go/Node 同名同构，含 `ok` + 业务字段 + `error`）。未知错误 = default 分支 = 漏 case 需补代码。
4. **`Counts` 类型归属**：`UpsertCounts{Inserted,Updated,Total}` 现在在 `importapi` 包，Repository 要用——是否移到 `record` 包（聚合根类型）？
   - 状态：✅ **已定案**——移到 `record` 包（Go `record.UpsertCounts`）/ `record.ts`（Node `UpsertCounts`），改名去掉 `importapi` 前缀。**硬约束**：否则 `recordrepo` import `importapi`（返回类型）+ `importapi` 业务函数调 `recordrepo.Upsert` = 循环依赖。`importapi.FormatImportNotifyMessage` 改用 `record.UpsertCounts` 入参；旧 `importapi.Counts` / `ImportCounts` 随迁移替换。签名表 #3 返回类型改为 `(record.UpsertCounts, error)`。JSON 键不变（`inserted`/`updated`/`total`，snake）。
5. **`transition`**：等 A5 定案后补。

- 状态：⏳ 讨论中（待定点 1-4 已定案；5 等 A5）

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

## F. 内部错误透传阶段 B（ErrInternal 防腐层，随 UoW 落地）

- 状态：✅ **已定案**（2026-08-06）。细节见 [`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md) §3.3 / §3.6；**实施时机 = UoW 落地时**（需 Repository 层作为三方库错误吸收点），不单独实施。
- 与 A2 / A3 关系：A2 已定「Repository 返回领域错误 + status 由业务函数返回（无 statusOf）」；A3 已定「error 字段承载领域错误对象」——阶段 B 为这套体系**补充 `ErrInternal`（内部错误）**，补全 400/404/409/500 四类 status 的领域错误覆盖。
- 内容：
  1. **`record.ErrInternal`**（Go）：`InternalError` 类型 + `ErrInternal(err)` 包装，**存原始 err + `Unwrap()` 保链**（`Error()` 返回原文，`errors.As` 命中 `InternalError`，底层链仍可 `errors.Is` 穿透判 SQLSTATE）。Node：`InternalError extends Error`，**随 Repository 一起引入**（与 `RecordNotFoundError`/`RecordConflictError` 对称，不 throw，放 `res.error`）。
  2. **Repository 层吸收三方库错误**（防腐层，唯一碰 SQL 的层）：`q.QueryRow/Exec/Query` 出错 → `res.Error = record.ErrInternal(err)`，替换普通 `fmt.Errorf` 包装。
  3. **handler 统一形态**：`logResponseError(status, logMsg, err)`（仅 ≥500 记日志）+ `writeError(w, status, errorDetail(err))`；`writeInternalError` 特殊通道**删除**。`errorDetail` 由阶段 A 引入（空 message 以 `%T` 类型名兜底）。
- 阶段 A（现在，先行）：`writeInternalError` 内部透传 + 守卫测试反转 + OpenAPI/AGENTS 同步——已在现行代码独立落地，不阻塞 UoW。

## 相关记录

- 架构定案：[`docs/20260805-repository-architecture.md`](20260805-repository-architecture.md)
- 首个采用接口：[`docs/20260805-tags-add.md`](20260805-tags-add.md)
- 回滚测试待办：架构文档「继承」节第 2 条（log/numbers 回滚测试）
- 内部错误透传（ErrInternal 防腐层 + 阶段 A 透传）：[`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md)
