# 复数化改造设计与验收清单（transactions / transactions-summary）

> 创建日期：2026-08-05
> 性质：复数化系列收尾的实施蓝图与验收清单。`log/numbers` 已完成，剩余 `log/transactions` 与 `query/transactions/summary` 两个端点；本文件给出**命名基准、逐类改动清单、操作纪律、验收清单**。
> 触发：[`docs/20260805-log-number-batch.md`](20260805-log-number-batch.md)「命名一致性待办」定案 3 项复数化；numbers 已实现，开工前需先精确影响面并确立「禁止全局替换」的分角色改动规则。

## 1. 任务定义

- **判据（已定案）**：一次性处理多个记录的端点用复数。集合视图空间（query）聚合多条 → 复数；动作空间（log）一次多条 → 复数。
- **清单与状态**：

| 端点 | 状态 |
|---|---|
| `POST /api/log/numbers` | ✅ 已实现（`019d368` 一次到位：改名 + 批量同时） |
| `POST /api/log/transaction` → `POST /api/log/transactions` | ✅ 已实现（见下「实现待办」状态） |
| `GET /api/query/transaction/summary` → `GET /api/query/transactions/summary` | ✅ 已实现（见下「实现待办」状态） |

- **单数不动**：`POST /api/log/text`、`/api/log/todo`、`/api/log/review`、`/api/log/body/weight`（一次单条）。

## 2. 命名基准（log/numbers 已完成先例，逐项实测）

复数化**不是**「所有含 transaction 的词都加 s」。以 `log/numbers` 的实际落地为唯一基准，标识符按角色分层：

| 层 | numbers 先例（实测） | 规则 |
|---|---|---|
| API 路径 | `POST /api/log/numbers` | **复数** |
| handler | `handleLogNumbers` | **复数** |
| 请求体类型 | `LogNumbersBody` | **复数** |
| 通知标题（用户可见英文） | `New numbers batch` | **复数** |
| draft 模块 | `numberdraft` | **单数**（领域标识，非请求形状） |
| 解析函数 | `ParseNumberBatch` / `parseNumberBatch` | **单数**（Batch 已表批量） |
| 落库函数 | `CreateNumberBatch` / `createNumberBatch` | **单数** |
| 通知函数 | `NotifyNumberBatchInserted` / `notifyNumberBatchInserted` | **单数** |
| 整单类型 | `NormalizedNumberBatch` | **单数** |
| 单条类型 | `NumberEntryInput` / `NormalizedNumberEntry` | **单数**（entry 是单条） |
| 批量响应 schema | `NumberBatchSuccess` | **单数** |
| fixture 文件名 | `number-batch-success.json`、`log-number-request-*.json` | **单数**（文件名非契约） |

**推论**：复数化只作用于**端点资源空间**（路径、handler、请求/响应体、端点同名函数/类型、通知标题）；单条概念（Entry）、批量操作概念（Batch）、模块名、fixture 文件名一律不动。

## 3. transaction 改动分类清单（禁止全局替换）

`transaction` 词在仓库分 **5 种角色**，逐一对照；任何一处判断失误都会误伤 102 处 `transaction_entry` tag。

### A. 改复数（端点/资源强相关）

| 位置 | 改动 |
|---|---|
| Go `server.go:76` 注册 | `POST /api/log/transaction` → `POST /api/log/transactions` |
| Go `server.go:83` 注册 | `GET /api/query/transaction/summary` → `GET /api/query/transactions/summary` |
| Next 目录 | `src/app/api/log/transaction/` → `…/log/transactions/`；`src/app/api/query/transaction/summary/` → `…/query/transactions/summary/` |
| Go handler | `handleLogTransaction` → `handleLogTransactions`（对齐 `handleLogNumbers`）；`handleTransactionSummary` → `handleTransactionsSummary` |
| 请求体类型 | TS/Go `LogTransactionBody` → `LogTransactionsBody`（对齐 `LogNumbersBody`） |
| summary 函数/类型（TS+Go 双份） | `ParseTransactionSummaryParams`/`parseTransactionSummaryParams`、`AggregateTransactionSummary`/`aggregateTransactionSummary`、`FetchTransactionSummary`/`fetchTransactionSummary`、`ParsedTransactionSummaryRange`、`TransactionSummaryResult`、`TransactionSummaryRow` → `*Transactions*` |
| OpenAPI schema | `LogTransactionRequest` → `LogTransactionsRequest`（schemas.yaml:867 + paths/log.yaml:306 的 `$ref`）；`TransactionSummarySuccess` → `TransactionsSummarySuccess`（schemas.yaml:332 + query.yaml:127 的 `$ref`） |
| OpenAPI operationId | `logTransaction`（log.yaml:283）→ `logTransactions`；`queryTransactionSummary`（query.yaml:85）→ `queryTransactionsSummary` |
| OpenAPI 路径键 | log.yaml `/api/log/transaction:`；query.yaml `/api/query/transaction/summary:`；**openapi.yaml 顶层 `$ref` 键**（:66-79，含 `~1` JSON 指针转义） |
| 通知标题 | `New transaction batch` → `New transactions batch`（telegram.ts:126 / telegram.go:198，各 1 处，已确认无测试断言） |
| 测试 import 别名 | `postTransaction` → `postTransactions`（routes.test.ts、json-body.test.ts，对齐 `postNumbers`） |
| 测试文件名 | `src/lib/query.transaction-summary.test.ts` → `query.transactions-summary.test.ts`（跟随 summary 端点复数） |
| 测试 URL/describe/注释 | `tests/api` 的 `/api/log/transaction`、`/api/query/transaction/summary`；Go `server_test.go:159/232/271/749-753`；注释：transactiondraft.go:34,228、query.go:393、transactiondraft.ts:197、query.ts:300 |

### B. 保持单数（对齐 NumberBatch 先例）

| 位置 | 原因 |
|---|---|
| `ParseTransactionBatch` / `parseTransactionBatch` | 对齐 `ParseNumberBatch` |
| `CreateTransactionBatch` / `createTransactionBatch` | 对齐 `CreateNumberBatch` |
| `NormalizedTransactionBatch` | 对齐 `NormalizedNumberBatch` |
| `TransactionEntryInput` / `NormalizedTransactionEntry` / `TransactionEntry`（Go+TS+schema:846） | 对齐 `NumberEntryInput` / `NormalizedNumberEntry`（单条） |
| `MaxTransactionEntries`（transactiondraft.go:16） | 已确认仅包内引用；对齐单数 |
| `NotifyTransactionBatchInserted` / `notifyTransactionBatchInserted` / `formatTransactionBatchMessage` | 对齐 `NotifyNumberBatchInserted` / `formatNumberBatchMessage` |
| `TransactionBatchSuccess` schema（schemas.yaml:899） | 对齐 `NumberBatchSuccess` |
| `TransactionType` / `TransactionCategorySegment` schema（:836/:823）、TS `TransactionType` / `TRANSACTION_TYPES` | **语义判断**：描述单个交易对象/类型枚举，非端点资源 |
| `transactiondraft` 模块 | 对齐 `numberdraft` |
| Go 测试名 `TestParseTransactionBatch*` / `TestCreateTransactionBatch*` | 对齐 number 测试名 |
| fixture 文件名 | `log-transaction-request-*.json`、`transaction-batch-success.json`、`transaction-summary-success.json`、`testdata/transaction-summary-cases.json` 全部不动；**测试代码里引用这些文件名的字符串不动** |

### C. 永不改（数据层 tag，102 处）

`transaction_entry`（前缀、落库 `transaction_entry:{type}`、schema/parameters 描述、`transactionEntryTypeTag`、`transactionTypeFromTags`、`RESERVED_TAG_PREFIXES`、`BARE_RESERVED_TAG_HINTS`、`transaction_entrypoint` 防误伤例子、import/export JSONL 里的 tag）。

### D. 特别说明

- **`summary-success.json` ≠ `transaction-summary-success.json`**：前者是 admin `records/stats` 的 fixture，与交易无关，勿误改。
- **`query/transactions/summary` 的 `summary` 不可数**，只复化中间资源层 `transaction` → `transactions`。
- **hint 无需改**：保留前缀 hint 文案已解耦（`use the dedicated log API for this record type`），详见 [`docs/20260805-tag-design.md`](20260805-tag-design.md)「保留前缀 hint 文案（定案）」——复数化不产生「改 hint」工作项，已有实现（`ac54bc4`），非省略。

## 4. 操作纪律（禁止全局替换）

1. 禁止 `sed -i 's/transaction/transactions/g'`、编辑器全局替换、大小写不敏感的批量替换。
2. 逐文件、逐行、按「3. 分类清单」的角色判断；不确定的标识符先查 numbers 先例，再无先例按**语义**（单条/枚举 → 单数）。
3. 工具用 `grep`（本环境 ripgrep 输出有渲染问题，以 `grep` 为准）。
4. 每改完一类立即走查，不攒到最后。

## 5. 验收清单

1. **路径级全复数**：`grep -rn "log/transaction\|query/transaction" src/ faas/ openapi/ tests/` 只剩历史文档与「将来式」规划文档中的旧写法。
2. **tag 零变动**：`grep -rc "transaction_entry" src/ faas/ openapi/ tests/` 合计仍为 102（改动前后对比，一处不差）。
3. **单数类保持**：`ParseTransactionBatch`、`CreateTransactionBatch`、`TransactionEntryInput`、`NormalizedTransactionEntry`、`transactiondraft`、`TransactionBatchSuccess`、fixture 文件名、Go 测试名全部原样。
4. **双端 + OpenAPI + 双测试全绿**：`npm run test:unit`（Node+Go 无 DB 单元 + 契约）、`npm run test:integration`（双端 API）、`npm run openapi:lint`、typecheck。
5. **破坏式改名无残留**：旧路径 `POST /api/log/transaction`、`GET /api/query/transaction/summary` 在代码/OpenAPI/现行文档中零残留（历史 dev-log 与「将来式」规划句除外）。

## 6. 实现待办（S1–S7，参照 log/numbers）

**状态：全部完成。**

- S1 **handler/draft 内标识符**：`handleLogTransaction`→`handleLogTransactions`、`handleTransactionSummary`→`handleTransactionsSummary`、`LogTransactionBody`→`LogTransactionsBody`、summary 三函数三类型复数化（纯改名，无语义变化）。
- S2 **路由**：Next 目录改名（含 `route.ts` 内部 import/类型引用）；Go `server.go` 注册改复数。
- S3 **通知**：`New transaction batch` → `New transactions batch`（双端）。
- S4 **OpenAPI**：路径键、operationId、`LogTransactionsRequest`/`TransactionsSummarySuccess` schema 名 + 顶层 `$ref`。
- S5 **测试**：Node `tests/api`（import 别名、URL、describe）、Go `server_test.go`（URL、handler）、测试文件名、fixture 引用名不动。
- S6 **文档**：`faas/README.md` 端点清单更新（**顺手修 `log/number` 单数残留** → `log/numbers`）；`docs/20260805-status-analysis.md` 复数化节标记完成；本文件标记已实现。
- S7 **验收**：按 §5 全项执行。

## 7. 历史文档处理

- **不改**（历史记录）：`docs/20260801-development-log.md`、`docs/20260802-todo-feature.md`、`docs/20260802-db-probe-multi-cloud.md`。
- **保留「将来式」**：`docs/20260805-log-number-batch.md:79-80`（待办箭头）、`docs/20260805-status-analysis.md`、`docs/20260805-tag-design.md:22`（hint 解耦表述）——语义是「叙述将发生的变化」，改了即失真。
- **修正过时**：`docs/20260805-log-number-batch.md:95`「改复数需同步改 hint 文案」已因 hint 解耦过时；`:124-126`「复数化不扩散到模块/函数名层」与先例不符（handler/请求体实为复数）——两处一并修正并指向本文件。

## 8. 相关记录

- 命名一致性判据与清单：`docs/20260805-log-number-batch.md`「命名一致性待办」。
- hint 解耦定案：`docs/20260805-tag-design.md`「保留前缀 hint 文案（定案）」。
- numbers 实现基线：`faas/internal/numberdraft`、`src/lib/numberdraft.ts`、`handleLogNumbers`、`LogNumbersBody`、`New numbers batch`。
- 交易实现：`src/lib/transactiondraft.ts` / `faas/internal/transactiondraft` / `logapi.CreateTransactionBatch`。
