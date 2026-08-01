# DigitalTwin2026 开发日志

> 日期：2026-08-01（续至 2026-08-02）
> 状态：transaction 录入 + summary；金额 `MoneyAmountString` 收紧；body weight 写入；双端 API 对齐；统一 `notify_user` + QQ Bot；契约收紧（未知键 / `suppress_notification`）

## 0. 今日做成了什么（总览）

| 类别 | 已完成 |
|------|--------|
| Transaction 写入 | `POST /api/log/transaction`：顶层 `type` + `entries`；落库 `transaction_entry:{type}` 前缀 tag |
| Transaction 金额 | `MoneyAmountString`：≤2 位小数、禁零/+/空格、abs ≤ `999999999999.99`；通过后规范为两位小数入库；共享 fixture |
| Transaction summary | `GET /api/query/transaction/summary`：半开 `[from,to)`；按 income/expense + category→subcategory 层级聚合；`Money2String` |
| Body weight | `POST /api/log/body/weight`：保留 tag `body:weight`；`WeightAmountString` 1.00–500.00；无专用趋势 API |
| 双端对齐 | 大量 Next ↔ Go 契约/语义对齐（JSON、时区、UUID、鉴权路径、Telegram、query 等）；见 §2 |
| 分层文档 | [`docs/20260801-api-layering.md`](20260801-api-layering.md)：模块同构、§1.1 允许差异、§7 通知 |
| 通知统一 | `notify_user` / `NotifyUser`：Telegram + QQ 并行 timed await；`NOTIFY_ALLOW_IN_TEST` |
| QQ Bot | `POST /api/qqbot/probe`；运行时 C2C 主动发；本地 `npm run qqbot:listen-openid` |
| 部署 UX | `secrets:refresh-prod` / FC deploy：先问是否开启 TG/QQ，否→空串，是→填齐并探测 |
| 录入开关 | 四个 log 写入 API（number / text / transaction / body/weight）可选 `suppress_notification`（默认 false；true 跳过 notify） |
| 契约收紧 | 请求体未知 JSON 键 → 400 `Unknown JSON key: …`（`additionalProperties: false`） |
| Query 排序 | `GET /api/query` 固定 `happened_at ASC, id ASC`（无 `order` 参数；双端常量 + `testdata/query-records-list-order.json`） |
| 构建 | FC `go build -trimpath -ldflags="-s -w"`；tags→`tagsdb` 修 Vercel Client 打进 postgres |

**明确不做 / 延期**：Dashboard 支出组件、网页录入 UI；OpenAPI **不做** codegen / Schemathesis（此前已收口）。无专用 body-weight 趋势 API（用 `GET /api/query?tag=body:weight`）。

---

## 1. Transaction 写入（上半日）

| 项 | 约定 |
|----|------|
| 路径 | `POST /api/log/transaction`（ApiToken） |
| Body | `happened_at` + `type`（`income`\|`expense`）+ `entries[]` |
| entries | 1..100；`amount` 为 `MoneyAmountString`；正=正常、负=该 type 冲销 |
| 落库 tags | `["transaction_entry:{type}","{category}:{subcategory}"]` |
| 保留 tag | 前缀语义 `P` 或 `P:…`（`P=transaction_entry` / `body:weight` 等）；number/text/Admin/rename 拒绝 |
| 感受/评价 | 另走 `POST /api/log/text` |

若库中仍有裸 tag `transaction_entry`（无 `:type`），需手工清理。

### 1.1 金额收紧（2026-08-02）

| 项 | 约定 |
|----|------|
| OpenAPI | `MoneyAmountString`（`entries[].amount`） |
| 正则 | `^-?(?:0\|[1-9]\d{0,11})(?:\.\d{1,2})?$`（整数部分 ≤12 位） |
| 拒绝 | JSON number；字面零（`0` / `0.0` / `-0`…）；`+` 前缀；空格（不 trim）；abs > `999999999999.99` |
| 错误文案 | 形态/零/量级/空格 → 统一 `Invalid amount: … absolute value at most 999999999999.99…`；number → `amount must be a decimal string` |
| 入库 | 通过后**字符串 pad** 为恰好两位小数（无 float）：`10`→`10.00`，`10.5`→`10.50`，`-1.5`→`-1.50` |
| 双端 fixture | `testdata/money-amount-cases.json`（Next `transactiondraft` + Go `transactiondraft`） |

相关：`src/lib/transactiondraft.ts`、`fc/internal/transactiondraft`、`fc/internal/logapi/transaction.go`、OpenAPI `LogTransactionRequest` / `MoneyAmountString`。

---

## 1b. Body weight 写入（2026-08-02）

| 项 | 约定 |
|----|------|
| 路径 | `POST /api/log/body/weight`（ApiToken） |
| Body | `happened_at` + `value_number`（kg，`WeightAmountString`）+ `objective_context`；可选 `subjective_interpretation` / `tags` / `suppress_notification` |
| 数值 | 正数、≤2 位小数、**1.00–500.00**；规范为两位小数入库；JSON number → 400 |
| 落库 tags | `["body:weight", ...可选客户端 tags]`（保留 tag 在前） |
| 保留 tag | 前缀 `body:weight` / `body:weight:*`（与 `transaction_entry` 并列）；number/text/Admin/rename 拒绝，文案指向专用路径 |
| 查询 | 无专用趋势 API；用 `GET /api/query?tag=body:weight` |
| 实现 | Next `CreateBodyWeight` + `bodyweightdraft`；Go `logapi.CreateBodyWeight` + `fc/internal/bodyweightdraft` |
| fixture | `testdata/weight-amount-cases.json` |

示例：

```bash
curl -sS -X POST "$BASE/api/log/body/weight" \
  -H "Authorization: Bearer $AI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"happened_at":"2026-08-02T08:00:00+08:00","value_number":"75.5","objective_context":"morning weigh-in","subjective_interpretation":"a bit heavy","tags":["morning"]}'
```

相关：`src/lib/bodyweightdraft.ts`、`fc/internal/bodyweightdraft`、`logapi.CreateBodyWeight`、OpenAPI `LogBodyWeightRequest` / `WeightAmountString`。

文档同步：四个 log 写入 API 列表（本日志 / `fc/README.md` / layering）均含 `body/weight`；`suppress_notification` 与 notify 扇出覆盖四路径。

---

## 1c. Transaction summary（2026-08-02）

| 项 | 约定 |
|----|------|
| 路径 | `GET /api/query/transaction/summary`（ApiToken） |
| Query | 必填 `from` / `to`（ISO+时区，同其它 query）；半开区间 `[from, to)`；`from >= to` → 400 |
| 计入行 | tags 含 `transaction_entry:income` 或 `transaction_entry:expense`，且另有合法 `{category}:{subcategory}`；脏行（缺 pair / null `value_number` / 非法字面量）跳过 |
| 聚合 | 带符号 `value_number` 求和（冲销可抵消）；`net` = `income.sum` − `expense.sum` |
| 层级 | `income_categories` / `expense_categories` → 每类含 `subcategories[]`（`CategoryBucket` / `SubcategoryBucket`） |
| 排序 | 类 / 子类：`sum` 降序，同 sum 则 name 升序（字节序） |
| 金额输出 | `Money2String`（恰好两位小数，如 `"0.00"`、`"799.50"`） |
| 双端 | `aggregateTransactionSummary`（`src/lib/query.ts`）↔ `AggregateTransactionSummary`（`fc/internal/query`）；路由 Next `src/app/api/query/transaction/summary`、Go `httpx` |
| fixture | `testdata/transaction-summary-cases.json`；契约 `openapi/fixtures/transaction-summary-success.json` |

OpenAPI：`TransactionSummarySuccess`、`MoneyBucket`、`CategoryBucket`、`SubcategoryBucket`、`Money2String`。

---

## 2. 双端 API 对齐与分层（中后段）

对照 OpenAPI / 集成期望，逐项收口 Next 与 Go FC，并写入分层规范：

- **分层**：HTTP 只 bind + 调 lib；业务在 `src/lib/*` ↔ `fc/internal/*` stem 对齐（[`20260801-api-layering.md`](20260801-api-layering.md)）
- **§1.1 允许差异**（刻意保留并注释）：404/405 框架默认 vs Go JSON；CORS 仅 FC；小数长度 `string.length` vs rune；notify 调度 `after()` vs `go`；`notify_user` snake_case；QQ token 缓存包级 vs per-Sender
- **代表性对齐修复**（节选）：畸形 JSON 400、RFC3339/`happened_at`、字段类型文案、rename、page 上限、时区 deny-list、LIKE 转义、UUID、`query?id=` 空数组、Telegram 失败文案、admin 鉴权前缀、`writeJSON` 关 HTML escape、body 256KiB→413、JSON 尾部垃圾、tags 字节序、`q` OR 括号等

验证习惯：`npm run openapi:lint`、`npm run test:openapi`、相关 vitest、`cd fc && go test ./...`（无 `DATABASE_URL` 时集成 Skip）。

---

## 3. 统一通知：`notify_user` + QQ Bot

### 3.1 运行时

- Next：`src/lib/notify.ts`、`src/lib/qqbot.ts`；Go：`fc/internal/notify`、`fc/internal/qqbot`
- 录入成功（number/text/transaction/body/weight）→ format（仍在 telegram 包）→ **`notify_user`**：已配置渠道并行 + ~15s timed await；失败只打英文日志
- 测试跳过：`DIGITAL_TWIN_TEST=1`；放行统一为 **`NOTIFY_ALLOW_IN_TEST=1`**（废弃 `TELEGRAM_ALLOW_IN_TEST`）
- Probe **不**经 `notify_user`：`POST /api/telegram/probe`、`POST /api/qqbot/probe` 各测单通道

### 3.2 QQ 配置与本地工具

- Env：`QQBOT_APP_ID` / `QQBOT_APP_SECRET` / `QQBOT_USER_OPENID`（三者齐全才启用）
- 主动 C2C（无 `msg_id`）；双 API base；access_token 缓存
- `npm run qqbot:listen-openid`：监听私聊拿 openid，并可回发确认（运维用，不进运行时扇出）

### 3.3 部署 / 刷新脚本

- `secrets:refresh-prod`：前三项 DB/Token **必填**（Sensitive `env pull` 常为空）；Telegram / QQ 改为 **Enable? [y/N]** → 否写空 upsert，是则填齐并实发验证
- FC `deploy.ts` 同逻辑；`DT_SKIP_NOTIFY_PROMPT`（兼容旧 `DT_SKIP_TELEGRAM_PROMPT`）
- `fc/s.yaml` 注入 `QQBOT_*`

### 3.4 `suppress_notification`

四个 log 写入 API（`/api/log/number`、`/api/log/text`、`/api/log/transaction`、`/api/log/body/weight`）请求体可选布尔：省略/null → false；`true` → 写入逻辑不变但跳过 notify；非 boolean → 写入前 400 `Invalid suppress_notification`。

---

## 4. 未知 JSON 键

此前 struct / 字段挑选会**静默忽略**多余键。现改为：

- OpenAPI 相关 request schema：`additionalProperties: false`
- 运行时：`rejectUnknownKeys` / `jsonutil.RejectUnknownObjectKeys`
- 400 文案：`Unknown JSON key: <name>`（多键按名字排序取第一个）
- 覆盖：log number/text/transaction（含 entry）/body/weight、Admin draft、rename、两 probe

---

## 5. 验证（当日相关）

- `npm run openapi:lint` / `npm run test:openapi` — pass
- 定向 vitest（notify / qqbot / suppress / unknown-keys / probes / transaction / body-weight / summary 等）— pass
- `cd fc && go test ./...` — pass（无 DB 时集成 Skip）
- 共享 fixture：`money-amount-cases.json`、`weight-amount-cases.json`、`transaction-summary-cases.json`
- 全量 `npm test` 若本机 Neon 不可达，含 DB 的集成会挂起；CI 无 DB 时 Skip

---

## 6. 今日提交（主题块，自新到旧节选）

```
a70bb4f / cc047a3  文档：四个 log 写入含 body/weight；layering + 开发日志
3939865 / 6e97b7b  POST /api/log/body/weight + WeightAmountString + 保留 tag
c5428ab / c3f17bc / cb98dd1  MoneyAmountString + 2dp 规范化 + abs 上限 + 共享 fixture
b77309e / a234f7b  GET /api/query/transaction/summary（层级聚合 + OpenAPI）
56a077d  更新 2026-08-01 开发日志：对齐、notify/QQ、契约收紧
22a9c8e  拒绝请求体未知 JSON 键，返回 Unknown JSON key。
5eda328  录入 API 支持 suppress_notification 跳过 notify。
42e510a  文档与注释标明 notify 双端刻意差异，并补齐 qqbot/notify 分层表。
8e58ea9  部署脚本改为先询问是否开启 Telegram/QQ 通知。
466ce68 / 64bd8d1 / 5795653  QQ Bot probe + notify_user 双端同构 + OpenAPI
179222c  refresh-prod 前三项必填 + qqbot:listen-openid
…（大量双端对齐 / transaction / CI / layering）
2f3850b / 27d20f4  transaction type + 保留 tag 前缀
```

完整列表以 `git log --since=2026-08-01` 为准。

---

## 7. 仍待办

- [x] `GET /api/query/transaction/summary`（按 `transaction_entry:income|expense` + 符号聚合；半开 `[from,to)`；category→subcategory 层级；两位小数串）
- [x] `POST /api/log/body/weight`（保留 tag `body:weight`；kg；无趋势 API）
- [x] Transaction `MoneyAmountString` 收紧（禁零、2dp 规范化、abs ≤ `999999999999.99`）
- [ ] Dashboard 支出组件 / 网页录入 UI
- [ ] 记录删除 / 图表 / 列表行内编辑
- [ ] 其它专用 log、AI CLI、数据导出
- [ ] QQ 主动消息依赖用户端「允许主动发送」；生产密钥轮换仍建议 Neon 控制台 + `refresh-prod` 粘贴
