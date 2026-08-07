# 双端 API 分层与同构规范

> 日期：2026-08-01  
> 状态：规范已落地；Phase 2–5 实现与验证已完成（2026-08-01）  
> 适用范围：Next（`src/app/api` + `src/lib`）与 Go FaaS（`faas/internal`）共享后端域

本文件是双端 **强对称** 的硬规范。改 API 实现前先对照本文；新增能力必须同时加两端同名模块 / 函数。

语言原则见根目录 [`AGENTS.md`](../AGENTS.md)：用户可见文案英文；文档与代码注释中文。

---

## 1. 目标与可行性边界

**目标**：同一业务能力在两端有同一分层、同一模块、同一函数职责、同一结构体字段；阅读一端即可预测另一端。

### 1.1 允许的字面差异

| 允许 | 说明 |
|------|------|
| 大小写 | Go 导出 `ParseHappenedAt`；TS `parseHappenedAt`（同一 **stem**） |
| 运行时类型 | Go `error` / `(T, status, error)`；TS 对等的 `{ error, status }` 或现有 Result 联合（**两端选同一种形状**，不用单端专有 Result 库） |
| DB / HTTP 适配器 | `pgx` vs Drizzle；`http.Request` vs `NextRequest` — **只出现在适配边界**，不进纯逻辑 |
| 前端专用 | `prefs` / `datetime-ui` / `api-client` 仅 TS，**不进**对照表 |
| **404 / 405 形态** | Go FC（`withJSONErrorPages`）统一 problem+json（RFC 9457，`{success:false,title,status,detail}`）；Next 未导出的 method / 未知 `/api/*` 仍用 **框架默认**（常非业务 JSON）。业务路径的 4xx/5xx 仍两端 problem+json 对齐 |
| **CORS / OPTIONS** | 仅 Go `withCORS`：跨域 Accelerate 需要预检 204、不鉴权；Next 同源 Vercel **不加** CORS，OPTIONS 也走 proxy 鉴权 → 401。属部署拓扑差异，非业务契约 |
| **小数长度计数** | Next `string.length`（UTF-16）；Go `utf8.RuneCountInString`。`DECIMAL_STRING` 仅 ASCII，合法字面量下二者相等；非法非 ASCII 会先被正则拒 |
| **通知调度** | Next `after()`（无 request scope 时退化 fire-and-forget）；Go `go` 协程。语义同为「HTTP 成功后不阻塞写响应的 best-effort notify」（见 §7） |
| **`notify_user` 大小写** | TS 导出 `notify_user`（snake_case，与契约/历史调用一致）；Go 导出 `NotifyUser`。同一 stem，属 §1.1 大小写惯用例外中的命名约定 |
| **QQ token 缓存粒度** | TS `qqbot` 包级 `tokenCache`；Go 每 `qqbot.Sender` 自带缓存。对外发送语义对齐，缓存归属随语言惯用（模块单例 vs 可注入 Sender） |

### 1.2 刻意不做的单端高级特性

- 不为 Go 单独上复杂泛型仓储；不为 TS 单独上装饰器或 class service
- 两端都用：**包级函数 + 普通 struct/type**，不用 class 作为业务载体
- SQL / Drizzle 写法保持「笨」、可逐行对照；rename 全表扫描等低效实现先对称

### 1.3 不追求

标识符字符串跨语言完全相同——只追求 **stem 相同 + 语言惯用大小写**。

---

## 2. 分层与禁令

```mermaid
flowchart LR
  HTTP["httpx handler / app/api route"]
  Lib["internal/X / lib/X"]
  DB["Postgres"]
  Side["notify（Telegram/QQ）"]
  HTTP -->|"bind only"| Lib
  Lib -->|"validate + DB"| DB
  Lib -->|"domain result"| HTTP
  HTTP -->|"status + JSON"| HTTP
  HTTP -.->|"after success"| Side
```

| 层 | 职责 | 禁止 |
|----|------|------|
| **HTTP**（`faas/internal/httpx`、`src/app/api/**/route.ts`） | 绑定请求、调用 lib、映射 HTTP status、写 JSON、成功后统一 notify 扇出 | **业务 SQL** / 业务校验编排（保留鉴权、CORS、框架绑定） |
| **lib / internal**（`src/lib/X`、`faas/internal/X`） | 校验、纯变换、DB 编排 | 直接写 HTTP 响应；在纯逻辑里依赖具体 HTTP 类型（适配器边界除外） |
| **db**（`faas/internal/db`、Drizzle schema） | 连接与表定义 | 业务规则 |

### 2.1 硬禁令

1. **禁止** `src/app/api/**/route.ts` 与 `faas/internal/httpx/server.go` 出现 **业务 SQL**（含内联 Drizzle `insert` / `update` / `select` 编排与 Go 裸 SQL）。例外：测试代码；`faas/internal/db` 连接辅助。
2. **禁止** 只改一端：共享后端新能力必须同时加两端同名模块 / 函数，并先更新本文对照表。
3. **禁止** 静默单端性能优化导致对称破缺（见 §8）。
4. **notify 留在 HTTP 层**：INSERT / 批处理成功后由 handler 经统一 `notify` best-effort 扇出（Telegram/QQ）；不把渠道发送塞进 `logapi` / `record` 的 DB 函数里。

### 2.2 已消除的偏差

以下偏差已在 Phase 2–5 落地，两端同构，**不再是缺口**：

- TS：`src/app/api/log/*`、normalize、query summary/tags 的业务 Drizzle 已抽到 `src/lib`（`logapi` / `tags` / `record` / `query`），与 Go 同构。
- Go：`server.go` 业务 SQL 已抽到 `tags` / `record` / `query` / `logapi`。
- 交易纯解析在 `transactiondraft`（两端独立模块）。
- 体重纯解析在 `bodyweightdraft`（两端独立模块）。

---

## 3. 同构规则

1. **同 stem**：`CreateNumber` ↔ `createNumber`；`NormalizeAcrossRecords` ↔ `normalizeAcrossRecords`；`FetchFilteredRecords` ↔ `fetchFilteredRecords`。
2. **同参数语义顺序**：Go 为 `(ctx, db, …)`；TS 用模块内默认 `db`，其余参数顺序与 Go 去掉 `ctx` / pool 后一致。写库路径：`NormalizeAcrossRecords` 接受 `*pgxpool.Pool`（内开事务 + `pg_advisory_xact_lock`）；TS `normalizeAcrossRecords` 生产同语义，可选末参 `store` 注入同构边界供单测（无真实锁）。
3. **同结构体字段名**：对外 JSON / JSONL 键一律 **snake_case**（见根 [`AGENTS.md`](../AGENTS.md)）；内部 DTO / Drizzle / Go struct 字段名可仍用惯用 camelCase / PascalCase，经 `json:"…"` 或显式序列化映射。API 记录类型两端都叫 **`Record`**（TS 已收敛原 `ApiRecord` / `TwinRecord` 到共享后端域的 `Record`；前端 `api-client` 可再导出别名）。
4. **同错误文案**：用户可见英文错误字符串必须字节级一致（契约测继续守）。
5. **先表后码**：本轮新建 / 迁移的符号必须先写入本文对照表再实现；禁止「Go 叫 `CreateText`、TS 叫 `makeText`」这类不对齐命名。
6. **包级函数 + 普通类型**：不用 class 承载业务。

---

## 4. 完整模块对照表

共享后端域必须 1:1。历史命名本轮收到同一 stem：

| Stem | Go | TS | 备注 |
|------|----|----|------|
| `tags` | `faas/internal/tags` | `src/lib/tags.ts` | 已有；含 `NormalizeAcrossRecords` |
| `draft` | `faas/internal/draft` | `src/lib/draft.ts` | 共享 helper：`ParseHappenedAt` / `RequireTrimmedText` / `OptionalTrimmedNullable` / `ValidateDecimalString` / `ParseNumericValue` / `EmptyStringToNull`。编辑草稿解析 `ParseRecordDraft` 已随 PATCH 删除（2026-08-04） |
| `transactiondraft` | `faas/internal/transactiondraft` | `src/lib/transactiondraft.ts` | **独立成包**（已落地）；TS 已由 `transaction-draft.ts` 改名；Go 已从 `logapi` 抽出纯解析 |
| `bodyweightdraft` | `faas/internal/bodyweightdraft` | `src/lib/bodyweightdraft.ts` | **独立成包**；体重 `numeric_value` 解析/规范化；落库 tags 组装含 `body:weight` |
| `tododraft` | `faas/internal/tododraft` | `src/lib/tododraft.ts` | **独立成包**；待办创建 / transition 纯解析；状态 tag 组装与替换；审计 `objective_context` 合成句与 `TodoAuditNotifyText` 通知模板；待办行 HTTP JSON 变形（`created_at`/`content`）；查询侧略宽判定 `ShouldDeformTodoRecordTags` / `shouldDeformTodoRecordTags` |
| `reviewdraft` | `faas/internal/reviewdraft` | `src/lib/reviewdraft.ts` | **独立成包**（已落地，2026-08-04）；复盘 `cadence` 枚举与纯解析；`review:{cadence}` tag 组装；规格 [`docs/20260804-log-review.md`](20260804-log-review.md) |
| `query` | `faas/internal/query` | `src/lib/query.ts` | 列表过滤 / 分页 / summary / tags / transaction summary；`ToQueryRecordJSON` / `toQueryRecordJson`（query `records[]` 待办变形） |
| `logapi` | `faas/internal/logapi` | `src/lib/logapi.ts` | TS 已新建；勿用 `log-api`；只保留创建 + SQL，解析委托 `draft` / `transactiondraft` / `bodyweightdraft` / `tododraft` / `reviewdraft` |
| `record` | `faas/internal/record` | `src/lib/record.ts` | TS 已合并原 `record-json.ts`；含 `FromDB` / `TagsJSON` / type `Record`。`Update` 已随 PATCH 删除（2026-08-04） |
| `recordjsonl` | `faas/internal/recordjsonl` | `src/lib/recordjsonl.ts` | Record JSONL 行 parse / serialize；表示层 snake_case；**不**调用 `assertNoReservedTags`（由调用方决定）；规格 [`docs/20260803-records-import-export.md`](20260803-records-import-export.md) |
| `exportapi` | `faas/internal/exportapi` | `src/lib/exportapi.ts` | `GET /api/export/records`：游标参数解析、按 `id ASC` `LIMIT` 拉取、有界组 NDJSON / 文件名 / Notify 文案；HTTP 层写出成功后再 Notify；规格同上 |
| `importapi` | `faas/internal/importapi` | `src/lib/importapi.ts` | `POST /api/admin/import/records`：multipart 校验、file≤4MiB 有界读入后 JSONL 单事务逐行 upsert、计数 / Notify 文案；HTTP 层负责 multipart 与 200 写出后再 Notify；**bypass** 256KiB JSON body 门闸；规格同上 |
| `telegram` | `faas/internal/telegram` | `src/lib/telegram.ts` | 渠道：配置 / 排版 / 发送；probe 直调；录入路径经 `notify` |
| `qqbot` | `faas/internal/qqbot` | `src/lib/qqbot.ts` | 渠道：配置 / token / 发送；probe 直调；录入路径经 `notify`（函数 stem 见 §5.2） |
| `notify` | `faas/internal/notify` | `src/lib/notify.ts` | 统一扇出入口；HTTP 成功后调用（函数 stem 见 §5.2；调度差异见 §1.1 / §7） |
| `dbprobe` | `faas/internal/dbprobe` | `src/lib/dbprobe.ts` | 短命连接探测 `POST /api/db/probe`；不查 `__drizzle_migrations` |
| `timeutil` | `faas/internal/timeutil` | `src/lib/timeutil.ts` | TS 已由 `time.ts` 改名 |
| `auth` | `faas/internal/auth` | `src/lib/auth.ts` | 已有 |
| `httpx` | `faas/internal/httpx` | `src/app/api/**/route.ts` | 框架层，**不要求**文件同名 |
| `db` | `faas/internal/db`（含可注入 `Querier`） | Drizzle schema（现有路径）；写库函数可选末参 `store` | 连接 / 表；非业务编排 |

**不进对照表（仅 TS 前端）**：`prefs`、`datetime-ui`、`api-client`。

**`transactiondraft` 独立**：不得把交易 batch 纯解析长期留在 `logapi`；`logapi` 只做 create + SQL，调用 `transactiondraft.ParseTransactionBatch` / `parseTransactionBatch`。

**`bodyweightdraft` 独立**：体重纯解析不得长期留在 `logapi`；`logapi.CreateBodyWeight` / `createBodyWeight` 只做校验结果落库。

**`tododraft` 独立**：待办纯解析与对外 JSON 变形不得长期留在 `logapi` / HTTP；`logapi.CreateTodo` / `createTodo` 与 `TransitionTodo` / `transitionTodo` 只做校验结果落库 / 事务；HTTP 创建成功响应用 `ToTodoRecordJSON` / `toTodoRecordJson` 变形；query `records[]` 用 `ShouldDeformTodoRecordTags` + `ToQueryRecordJSON` / `toQueryRecordJson`；transition 成功体无 record。

**`reviewdraft` 独立**：复盘纯解析不得长期留在 `logapi`；`logapi.CreateReview` / `createReview` 只做校验结果落库（自动附加 `review:{cadence}` tag，客户端不得传 `review:*`——保留前缀）。

---

## 5. 关键函数 / 类型对照

### 5.1 本轮已抽取 / 对齐（已落地）

| Stem | Go | TS |
|------|----|----|
| logapi | `CreateNumber` / `CreateText` / `CreateTransactionBatch` / `CreateBodyWeight` / `CreateTodo` / `TransitionTodo` / `CreateReview` | `createNumber` / `createText` / `createTransactionBatch` / `createBodyWeight` / `createTodo` / `transitionTodo` / `createReview` |
| transactiondraft | `ParseTransactionBatch`（及同包输入 / 归一化类型） | `parseTransactionBatch` |
| bodyweightdraft | `ParseBodyWeight` / `ParseWeightAmount` | `parseBodyWeight` / `parseWeightAmount` |
| tododraft | `ParseTodo` / `ParseTodoTransition` / `ToTodoRecordJSON` / `ShouldDeformTodoRecordTags` / `AuditObjectiveContext` / `TodoAuditNotifyText` / type `TodoRecordJSON` | `parseTodo` / `parseTodoTransition` / `toTodoRecordJson` / `shouldDeformTodoRecordTags` / `auditObjectiveContext` / `todoAuditNotifyText` / type `TodoRecordJson` |
| reviewdraft | `ParseReview` / type `NormalizedReview` | `parseReview` / type `NormalizedReview` |
| query | `ParseRecordQueryParams` / `FetchFilteredRecords` / `ToQueryRecordJSON` / `RecordsForResponse` / … | `parseRecordQueryParams` / `fetchFilteredRecords` / `toQueryRecordJson` / … |
| tags | `NormalizeAcrossRecords` / `ValidateNormalize` | `normalizeAcrossRecords`（`tagsdb`）/ `validateNormalize`（`tags`） |
| record | `FromDB` / `TagsJSON` / type `Record` | `fromDB` / `tagsJSON` / type `Record`（已取代 `toApiRecord` / `ApiRecord`，或薄包装同名） |
| record | `FormatHappenedAt` | `formatHappenedAt`（读路径：瞬间 + 隐列 `utc_offset` 带区；无 offset 重载仅作损坏回退。见 [`docs/20260803-utc-offset.md`](20260803-utc-offset.md)） |
| record | `IsValidID` / `InvalidID` | `isValidRecordId` / `INVALID_RECORD_ID` |
| recordjsonl | `ParseLine` / `SerializeLine` / `SerializeRecord` / `FormatLineError` / type `Row` | `parseLine` / `serializeLine` / `serializeRecord` / `formatLineError` / type `RecordJsonlRow` |
| exportapi | `ParseExportRecordsParams` / `FetchExportRecords` / `BuildExportNdjson` / `ExportFilename` / `FormatExportNotifyMessage` / type `ParsedExport` | `parseExportRecordsParams` / `fetchExportRecords` / `buildExportNdjson` / `exportFilename` / `formatExportNotifyMessage` / type `ParsedExport` |
| importapi | `ImportRecordsJSONL` / `FormatImportNotifyMessage` / `FormatDuplicateIDError` / `IsAcceptedImportFilePart` / type `Counts` | `importRecordsJsonl` / `formatImportNotifyMessage` / `formatDuplicateIdError` / `isAcceptedImportFilePart` / type `ImportCounts` |

### 5.2 同构样板（保持 / 微调 stem）

| Stem | Go | TS |
|------|----|----|
| draft | `EmptyStringToNull` / `ParseHappenedAt` / `ValidateDecimalString` / `ParseNumericValue` | `emptyStringToNull` / `parseHappenedAt` / `validateDecimalString` / `parseNumericValue` |
| tags | `IsValidTag` / `IsReservedTag` / `ValidateTags` / `AssertNoReservedTags` / `ValidateNormalize` / `normalizeTags` / `AggregateTagCounts` / `NormalizeAcrossRecords` | `isValidTag` / … / `aggregateTagCounts`（`@/lib/tags`，可进 Client）；`normalizeAcrossRecords`（`@/lib/tagsdb`，仅服务端，避免 Client 打进 postgres） |
| tags | `ValidationResult{Valid, Error}` | `ValidationResult{ valid, error? }`（`assertNoReservedTags` / `validateTags` / `validateNormalize` 共用） |
| tags | 脏 `tags` JSON：`AggregateTagCounts` / `normalizeTags`（及 `NormalizeAcrossRecords`）解析失败或根非数组 → **error**（HTTP 500） | 同左：抛错 / 向上失败，**禁止**静默 skip |
| query | `ParseRecordQueryParams` / `FetchFilteredRecords` / `FetchSummary` / `FetchTagCounts` / `EscapeLikePattern` / `ParseTransactionsSummaryParams` / `AggregateTransactionsSummary` / `FetchTransactionsSummary` | `parseRecordQueryParams` / `fetchFilteredRecords` / `fetchSummary` / `fetchTagCounts` / `escapeLikePattern` / `parseTransactionsSummaryParams` / `aggregateTransactionsSummary` / `fetchTransactionsSummary` |
| query | `FetchFilteredRecords` 在 lib 内 `FromDB`，返回 `[]Record`（HTTP 不再 map） | `fetchFilteredRecords` 在 lib 内 `fromDB`，返回 `Record[]` |
| timeutil | `IsValidTimeZone` / `GetZonedDayBounds` / `CalendarDayBounds` / `ExpandCompactOffset` / `ParseRFC3339Flexible` | `isValidTimeZone` / `getZonedDayBounds` / `calendarDayBounds` / `expandCompactOffset` / `parseRFC3339Flexible` |
| auth | `VerifyAPIAccess` / `VerifyAdminAccess` / `BearerToken` | `verifyApiAccess` / `verifyAdminAccess`（Bearer 适配器可保留框架差异） |
| telegram | `LoadConfig` / `ConfigError` / `FormatRecordMessage` / `FormatTransactionBatchMessage` / `SendMessage` | 同 stem：`loadConfig`、`configError`、`formatRecordMessage`、`formatTransactionBatchMessage`、`sendTelegramMessage` |
| qqbot | `LoadConfig` / `ConfigError` / `SendMessage` / `Configured` | 同 stem：`loadConfig`、`configError`、`sendQqMessage`、`isConfigured` |
| notify | `ShouldSuppressBotNotification` / `NotifyUser` / `NotifyRecordInserted` / `NotifyTransactionBatchInserted` / `TruncateNotifyMessage` | 同 stem：`shouldSuppressBotNotification`、`notify_user`、`notifyRecordInserted`、`notifyTransactionBatchInserted`、`truncateNotifyMessage`（>4000 字符统一截断，2026-08-04） |
| dbprobe | `Probe` / `SanitizeProbeError` / type `Result` | `probeDatabase` / `sanitizeProbeError` / type `DbProbeResult` |

后续若发现表内遗漏符号，**先改本文再改代码**。

---

## 6. 错误返回形状

两端业务函数对「可映射为 HTTP」的失败采用 **同构形状**（偏现有 `logapi`）：

| | Go | TS |
|--|----|----|
| 成功带实体 | `(Record, status, nil)` 或 `(n, []Record, status, nil)` | `{ record, status }` / `{ inserted, records, status }` 等与 Go 字段语义对齐 |
| 失败 | `(_, status, err)`，`err.Error()` 为用户可见英文 | `{ error: string, status: number }`（或等价联合，**两端字段语义一致**）——**内部函数 Result**，HTTP 层统一映射为 problem+json |
| HTTP 层 | 组装 problem+json（`success:false` + `statusTitle(status)` + `detail`），Content-Type `application/problem+json`；不改写业务文案 | 同左 |

约束：

- 用户可见 `detail` 字符串与 OpenAPI / 契约 fixtures **字节级一致**（HTTP 错误形状 RFC 9457，见 `docs/20260805-error-response-shape.md`）
- 不引入仅一端使用的 Result 库或错误码枚举体系（除非双端同时引入并写入本文）
- **请求 body 上限**：双端写路径均为 **256 KiB**（`MAX_HTTP_BODY_BYTES` / `httpx.MaxBodyBytes`）。超限 → **413** + `Request body too large`（禁止静默截断后再当残缺 JSON）。

---

## 7. 通知与 HTTP

- 通知触发点：**HTTP handler**，在 lib 返回成功之后，经统一入口 `notify`（`NotifyUser` / `notify_user`）。写路径成功后**一律** schedule；**无**请求体 `suppress_notification`（该键视为未知键 → 400）。
- 是否真发 bot：仅看进程 env **`SUPPRESS_BOT_NOTIFICATION`**（trim 后严格 `'1'` 才在 `notify_user` 内早退）。`deploy -- test` 强制注入 `=1`，`deploy -- prod` 强制 `=0`。真源：[`docs/20260803-suppress-bot-notification.md`](20260803-suppress-bot-notification.md)。
- `telegram` / `qqbot` 仅为渠道（配置、发送；TG 另含排版）；probe（`POST /api/telegram/probe`、`POST /api/qqbot/probe`）走各渠道 `SendMessage`，**不**经 `notify`，**不受** `SUPPRESS_BOT_NOTIFICATION` 约束。
- **不**在 `CreateNumber` 等 DB 函数内部发送。
- 失败 best-effort：不影响已成功写入的 HTTP 状态码（与现行为一致）。
- **不阻塞写响应**：Next 用 `after()`（无 request scope 时退化为 fire-and-forget）；Go 用 `go` 协程。客户端 HTTP 超时两端均为 **15s**（Next `AbortSignal.timeout` / Go `http.Client.Timeout`）。

---

## 8. 性能导致对称破缺的流程

默认：**先对称，后破缺**。

若某端因性能必须偏离（例如 rename 不再全表扫描）：

1. 开议题说明动机、拟议双端最终形态、临时是否允许单端先行。
2. **双端**在本文或同目录短备注中记录破缺点与恢复对称的计划。
3. **禁止**静默只改一端 SQL / 算法而不更新文档与对照端。

在破缺获批并文档化之前，两端保持可逐行对照的「笨」实现。

---

## 9. 与 OpenAPI / 测试的关系

- **不**借分层重构修改对外 HTTP 契约与鉴权语义。
- 改实现后仍跑：`npm test`、`cd faas && go test ./...`、`npm run test:openapi`、`cd faas && go test ./internal/contract/`。
- 抽检：`src/app/api` 与 `faas/internal/httpx/server.go` 无业务 SQL。

---

## 10. 变更检查清单（给实现代理）

以下为**后续变更**自检模板，非本轮未完成项（本轮同构落地已核；Phase 2–5 / P1 / DB mock 已完成）。

- [ ] 对照表已包含新符号（先改本文）
- [ ] Go `faas/internal/<stem>` 与 TS `src/lib/<stem>.ts` 同时存在
- [ ] 函数 stem / 字段名 / 错误文案对齐
- [ ] HTTP 层无业务 SQL；notify（Telegram/QQ）仅在成功后由 HTTP 经统一入口调用
- [ ] 契约测与双端单测通过
