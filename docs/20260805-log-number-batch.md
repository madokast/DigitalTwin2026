# Log Number 批量改造设计

> 创建日期：2026-08-05
> 性质：记录 `POST /api/log/number` 从单条改批量的设计讨论与定案，供实现与 OpenAPI 契约引用。
> 触发：AI 使用场景需一次记录多项数值（体温、血压、体重等），单条接口往返过多。

## 背景：现状

- `POST /api/log/number` 当前是**单条插入**：
  `{happened_at, numeric_value, raw_content, objective_context, tags?, ai_analysis?}` → 201 `{success, record}`。
- 记录实际单条形状：`numeric_value` → numeric_value；`raw_content` / `objective_context` 均必填。
- 前端与 `api-client` **不调用**该端点（仅 AI 客户端用），破坏式改造无前端连带。

## 设计原则：对齐记账 `POST /api/log/transaction`

记账批量是既有成熟模式，number 批量完全复刻：

- 顶层共享字段 + `entries` 数组。
- 整单单事务（`atomic: true`，全成或全败）。
- 单条校验失败 → 400 带 `entries[i]: …` 前缀（一次一个错误，fail-fast）。
- 成功 → `{success, inserted, atomic}`（不回传 records）。

## 记账落库映射（参考基准）

记账 entry `{amount, memo, category, subcategory}`：

| 字段 | 落库 |
|---|---|
| `amount` | numeric_value |
| `memo` | **objective_context**（不是 raw_content！） |
| `category` / `subcategory` | tags（`{category}:{subcategory}`） |
| — | raw_content = **NULL** |

关键：记账 **没有任何信息进 raw_content**，`memo` 落在 `objective_context`。

## 已定案

- **`POST /api/log/number` 改为批量**（破坏式改造，不复用单条；不兼容旧形状）。

```
POST /api/log/number
{
  "happened_at": "2026-08-05T10:00:00+08:00",
  "entries": [
    { "numeric_value": "36.8", "memo": "axillary temperature", "tags": ["vitals"] },
    { "numeric_value": "75.5", "memo": "fasting weight", "tags": ["body"] }
  ]
}
→ 201 { success, inserted: 2, atomic: true }
```

| 字段 | 规则 |
|---|---|
| 顶层 `happened_at` | 必填，整批共享时间戳 |
| 顶层 `entries` | 非空数组，1..100 项（对齐记账 `MaxTransactionEntries`） |
| entry `numeric_value` | 必填 decimal string（复用 DecimalString） |
| entry `memo` | **必填非空** → objective_context（**DB `objective_context` NOT NULL**，见 `src/db/schema.ts`——强制必填，draft 层 400 校验，非 DB 层 500） |
| entry `tags` | **可选**（省略 → `[]`，对齐全系统 log 端点），传了则不得含保留前缀（`transaction_entry`/`body:weight`/`todo`/`review`） |
| entry `ai_analysis` | **可选**（兑现双写文档「专用 API 一并填 ai_analysis」；对齐 `optionalTrimmedNullable`：省略/`null` → null；`""`/空白 → 400 `ai_analysis must not be blank`；非空串 trim 后存） |
| 无 `raw_content` | 对齐记账（raw_content=NULL） |
| 响应 | `{success, inserted, atomic}`——**不回传 ids**（UUID 无实际意义；原子操作成功即全部完成；补 tag 是独立的「任意记录 + 任意时间」搜索辅助，不依赖批量 ids） |
| 条错误 | `entries[i]: <字段错误>`（fail-fast，一次一个） |
| 原子性 | 单事务，全成或全败 |

- **数组字段名用 `entries`**（非 `values`）：与记账完全一致，AI/客户端「批量 = entries」认知复用；条错误/上限文案与记账逐字对齐；双端、OpenAPI、测试均复用记账先例。
- **entry `tags` 可选而非必填**（修正）：所有 log 端点（number 单条、text、body/weight、todo、review）的 `tags` 均可选（省略 → `[]`）；记账 entry 无 tags 字段是因为服务端自动生成，非「客户端必填」先例。批量数值场景（如一组体温）往往无每条的语义 tag，强制必填是负担。传了则校验格式 + 拒保留前缀。

## 待决策（已解决）

1. ~~**端点是否改名** `POST /api/log/number` → `POST /api/log/numbers`~~：✅ **已定案改名**——复数化判据「一次处理多个记录 → 复数」（见下「命名一致性待办」）。

## 命名一致性待办（另一条线）

- **复数规则不统一**：`/api/query/transaction/summary` 用单数 `transaction`，而 `/api/admin/records/stats` 用复数 `records`。
- **复数化判据（已定）**：**一次性处理多个记录的端点用复数**。
  - 集合视图空间（query/admin/export）聚合多条 → 复数；
  - 动作空间（log）一次单条 → 单数；一次多条 → 复数。
- **已定复数化清单**：
  1. `GET /api/query/transaction/summary` → **`GET /api/query/transactions/summary`**（集合视图，聚合多条）。
  2. `POST /api/log/transaction` → **`POST /api/log/transactions`**（已是批量 `entries`，一次多条）。
  3. `POST /api/log/number` → **`POST /api/log/numbers`**（批量改造后，一次多条）。
  - 单数不动：`POST /api/log/text`、`/api/log/todo`、`/api/log/review`、`/api/log/body/weight`（一次单条）。
- **待办**：双端（Next routes / Go `HandleFunc` 路径 + OpenAPI paths + fixtures + 集成测试 + AI 使用文档）同步迁移。

## 复数化影响面（调研）

| 端点 | 代码引用量 | 分布 |
|---|---|---|
| `POST /api/log/number` | 85 处 | Next route + route.test + Go server/handler + httpx 各集成测 + OpenAPI（openapi.yaml/schemas.yaml/paths/log.yaml）+ `src/lib/draft.ts` + `src/proxy.test.ts` + 多个历史文档（30/31/04-dev-log、parity-audit、suppress-bot、todo-feature、faas README） |
| `POST /api/log/transaction` | 34 处 | Go server/handler + transactiondraft（TS/Go）+ tags.ts/test（保留前缀 hint 文案引用路径）+ OpenAPI + `tests/api` 两处 + 历史文档（todo-feature、dev-log、status-analysis） |
| `GET /api/query/transaction/summary` | 9 处 | Go server/query + Next `src/lib/query.ts` + OpenAPI（openapi.yaml/query.yaml）+ httpx server_test |

**要点**：
- 三者都涉及**双端代码 + OpenAPI + 测试**，但 `log/number` 引用最多（85），因含 route.test、proxy.test、多个集成测、以及**历史文档**里的端点名（历史 dev-log 通常不回改，属「记录当时事实」）。
- `log/transaction` 的复数化会被 `tags.ts`/`tags.go` 的**保留前缀 hint 文案**引用（`use POST /api/log/transaction for transaction line entries`）——改复数需同步改 hint 文案。
- 三者**独立执行**（不合并）：各含自己的 OpenAPI path、路由、fixtures、测试迁移；顺序上 `log/number` 与批量改造一起动，另两个可各自单独 PR。
- 历史文档只更新「当前契约」类（如 status-analysis、本设计文档、AI 使用文档）；纯历史 dev-log 保留原状。

## 实现待办（定案后）

- **numberdraft**（对齐 `transactiondraft`）：`ParseNumberBatch`——顶层 happened_at + entries（1..100），entry `numeric_value`/`memo` 必填、`tags`/`ai_analysis` 可选；条错误 `entries[i]: …`。
- **双端 logapi**：`CreateNumberBatch`——单事务；memo→objective_context；numeric_value→numeric_value；tags 保留前缀校验（含 `body:weight`——体重应走 `/api/log/body/weight`）。
- **路由/handler**：Next route + Go `handleLogNumber` 改用批量，响应 `{success, inserted, atomic}`。
- **OpenAPI**：`LogNumberRequest` 重构为批量；新增 `NumberBatchSuccess`（`required: [success, inserted, atomic]`）；fixtures 同步。
- **测试**：双端单测（draft 校验/条错误/上限）+ 集成 + 契约重写；Go `CreateNumber` 相关旧测试移除。
- **AI 使用文档**：更新 number 调用为批量；`docs/20260805-status-analysis.md` 同步。

## 相关记录

- 记账批量实现：`src/lib/transactiondraft.ts` / `faas/internal/transactiondraft` / `logapi.CreateTransactionBatch`。
- 记账 OpenAPI：`LogTransactionRequest` / `TransactionBatchSuccess`（schemas.yaml §808+）。

## 新需求（记录，另行设计）

- **按 id 补 tag / 删 tag**：独立设计文档 [`docs/20260805-tags-add.md`](docs/20260805-tags-add.md)。鉴权已定（ApiToken）；add/remove、幂等、404 等详见该文档。
  - 与批量接口**无耦合**：批量响应不回传 ids（UUID 无意义、原子操作成功即完成），补 tag 是独立搜索辅助，AI 用 query 搜回 id 后调用。
