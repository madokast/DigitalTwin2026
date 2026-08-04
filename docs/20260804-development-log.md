# DigitalTwin2026 开发日志

> 日期：2026-08-04  
> 状态：双后端 API 行为/契约集中打磨：Parity D1–D8 全修复、测试门闸重构、Neon → 标准 PostgreSQL、字段改名、tags 数组化、全字段 trim、transaction/import 原子性、query 排序；范围收口定稿  
> 相关：[`20260804-scope-closure.md`](20260804-scope-closure.md)、[`20260804-rename-value-text-to-raw-content.md`](20260804-rename-value-text-to-raw-content.md)、[`20260803-api-parity-audit.md`](20260803-api-parity-audit.md)、[`20260803-records-import-export.md`](20260803-records-import-export.md)

## 0. 今日做成了什么（总览）

| 类别 | 已完成 |
|------|--------|
| Parity 审计 | D1–D8 双端差距全部修复（[§1](#1-parity-审计-d1d8-全修复)） |
| 测试门闸 | `npm run test:unit` / `test:integration` 重构；Node 与 Go 集成门闸对齐 `.env.test`；CI 新增 `typecheck`（[§2](#2-测试门闸)） |
| 数据库 | 只留标准 PostgreSQL，全面移除 Neon 引用；删除 `secrets:rotate-test` 脚本（[§3](#3-标准-postgresql--移除-neon)） |
| 命名翻新 | `value_text` / `value_number` → `raw_content` / `numeric_value`，全仓库 + OpenAPI + DB 同步（[§4](#4-字段与语义翻新)） |
| 字段语义 | tags 读侧数组化 + 空数组合法；`raw_content` 必填；全字段 trim 入库；`numeric_value` null 时省略键（[§4](#4-字段与语义翻新)） |
| 写路径响应 | transaction 返回 `type` + 定点代数 `sum`；transaction / import 恒回显 `atomic: true`（[§5](#5-写路径与响应契约)） |
| query | `sort_by`（`happened_at`\|`id`）+ `sort_order`（`asc`\|`desc`），响应回显（[§5](#5-写路径与响应契约)） |
| 范围收口 | happened_until / LLM 接入层 / 设备上报 / `source:*` / 聚合 / 图表 / gzip 终止（[§6](#6-范围收口)） |
| lint/tsc | 既有 lint 错误、warning、tsc 类型错误全清（`779f35e` / `cb6086f`） |

---

## 1. Parity 审计 D1–D8 全修复

依据 [`20260803-api-parity-audit.md`](20260803-api-parity-audit.md)，全部差距已修（原「unfixed gaps」标注移除）：

| 项 | 修复 |
|----|------|
| D1 | probe 畸形 JSON → 双端 400（`b1dc306`） |
| D2/D2' | 顶层 null / 数组 / 字面量 JSON → 双端 `body must be an object` 400（`cc293ce`） |
| D3 | import multipart 缺 boundary → 双端 400（`6b9e48c`） |
| D4 | 非 file multipart 部分 Next 侧补 4 MiB 上限（`abf3ef1`） |
| D5 | text 部分命名 `file` → 双端 `unsupported Content-Type`（`c1c33cb`） |
| D6 | summary 只聚合严格规范十进制（定点），Go = Next（`f42b275`） |
| D7 | todo transition Next 侧补 UPDATE 受影响行检查（`8519078`）；race 测试入 `logapi.transition.test.ts`（`72229ad`） |
| D8 | dbprobe 连接超时双端统一 15s（`2a33a6b`） |

文档收尾：`9f3056c` 标记全部修复 + 记录 D4 无法对齐的非对齐说明；`f159813` 刷新审计摘要至 fully-fixed；`1237a32` / `a917468` 清理旧文档中过期的 gap 警告。

---

## 2. 测试门闸

- `24496fe` 新增 `npm run test:unit` 作为纯单元入口（无 DB）
- `c476314` README 测试节重排为 unit / integration 分块 + 前置条件 + 分侧命令
- `dc46a83` 测试包装器自动重建测试库表结构；禁用 `go test` 缓存防旧结果
- `9dc3b6a` Go 集成测与 Node 门闸对齐：自动加载仓库根 `.env.test`，无安全 `DATABASE_URL`（host/库名含 `test` / `TestDigitalTwin`）即 Skip
- `b9cf415` / `cb6086f` CI 与 `test:unit` 门入 `npm run typecheck`；既有 scripts/mocks/契约测试 7 处类型错误清零
- `779f35e` lint 清零（setState-in-effect → lazy init / render adjust、6 warning、page.tsx 去 `ready` state）

---

## 3. 标准 PostgreSQL / 移除 Neon

- `2dcbb2f` 代码、测试、配置注释中所有 Neon 引用移除（branching / serverless driver 等）
- `8083105` / `8c9c6d4` 架构文档改为「标准 PostgreSQL only，可切国内云或内网实例」；测试环境用独立库
- `4bd0296` / `8202983` rotate-test 脚本按 URL `sslmode` 推导 SSL 后整体删除（密钥流程由 deploy/collect 取代）

---

## 4. 字段与语义翻新

### 4.1 改名：`value_text` / `value_number` → `raw_content` / `numeric_value`

`7fe7972` 全仓库（代码/契约/DB/文档）+ 专项文档 [`20260804-rename-value-text-to-raw-content.md`](20260804-rename-value-text-to-raw-content.md)；`e197f8c` todo 审计行语义同步：存 `objective_context` + `content` 原文，通知用客观上下文。

### 4.2 tags 数组化 + 空 tags

- `518a919` 读侧 `tags` 全路径返回 JSON 数组：TS `Record.tags: string[]` + `fromDB`/`parseTagsField`；Go `ParseTagsField`；JSONL 导出数组格式并兼容旧字符串化数组（import 双兼容）；前端 `parseTags` 删除
- `54bd093` / `7c6a258` 空 tags 合法：省略 / `[]` / `null` 统一存 `[]` 读出 `[]`；DB 约束 `chk_tags` → `^\[.*\]$`；fixtures 补空数组/null/省略用例

### 4.3 `raw_content` 必填

`a4d1ce1` number 写路径新增 `raw_content` 键且非空白必填；text / body/weight 同步拒绝空白；OpenAPI、测试、fixtures 同步（`3d03f59` 清理残留）。

### 4.4 全字段 trim 入库

`fc414b5` 所有文本输入 trim 后入库；空串/空白串拒绝。共享 helper：TS `requireTrimmedText` / `optionalTrimmedNullable`（`src/lib/draft.ts`）= Go `RequireTrimmedText` / `OptionalTrimmedNullable`（`faas/internal/draft/draft.go`）；`emptyStringToNull` 删除。`subjective_interpretation` 例外：不传/null → null，`""`/空白 → 400（清空用 null）。weight/amount 反转旧「禁止 trim」设计，fixtures 空格用例从 reject 移入 accept。

### 4.5 tag 严格校验端到端

`670b9ae` / `3ee0ce6` 补端到端拒绝用例：`[' weight']` / `['weight ']` / `[' weight ']` / `['体重']` → 400 `Invalid tag`（log/number、PATCH、Go httpx）。tag 不 trim：pattern 本身拒绝空格（依据 fuzzy-time §2.5 精确匹配）。

### 4.6 `numeric_value` null 时省略键

`021a535` 读侧（Record / todo / query / export）null 时**省略** `numeric_value` 键：TS 条件键 + Go `omitempty`；`subjective_interpretation` 恒 null 仍显式返回。import 两侧 required 循环跳过 `numeric_value`（可省略或显式 null，双 null 校验保留）。

---

## 5. 写路径与响应契约

### 5.1 transaction：`type` + `sum` + 原子性

- `4dfa47f` 响应新增 `type`（transaction）+ `sum`：定点两小数代数合计（负数冲销相抵，如 `12.50 + -3.00 = 9.50`）；TS `sumMoneyAmounts2` = Go `SumMoneyAmounts2`
- `5c74a00` transaction 响应恒 `"atomic": true`（单事务提交）

### 5.2 import：原子性

`4207942` import 响应恒 `"atomic": true`；OpenAPI 两处 `const: true`，契约/测试同步。

### 5.3 query 排序

`23acfbd` `sort_by` = `happened_at`（默认）| `id`；`sort_order` = `asc`（默认）| `desc`（严格小写，`ASC`/空串 → 400）；`happened_at desc` 次键恒 `id ASC`；响应回显 `sort_by` / `sort_order`；共享 fixture `testdata/query-records-list-order.json` 覆盖 4 组合。

---

## 6. 范围收口

[`20260804-scope-closure.md`](20260804-scope-closure.md) 定稿（`518a919` 内一并提交），写入 AGENTS.md「范围收口（终止项）」：`happened_until` 时间段、LLM 接入层（tools/MCP）、设备上报、`source:*` 元 tag、records 数值聚合、图表/可视化、import/export gzip 全部终止，不再开发。transaction summary 例外保留。

---

## 7. 今日提交（自新到旧）

**API 语义 / 响应契约**：`4207942` import atomic · `23acfbd` query 排序 · `5c74a00` transaction atomic · `4dfa47f` transaction type+sum · `021a535` numeric_value 省略键 · `fc414b5` 全字段 trim · `a4d1ce1` raw_content 必填 · `54bd093` 空 tags · `518a919` tags 数组化 · `7fe7972` value_text/value_number 改名

**测试 / 门闸 / CI**：`3ee0ce6` Go 端 tag 拒绝 · `670b9ae` Node 端 tag 拒绝 · `7c6a258` JSONL 空 tags 用例 · `b9cf415` CI typecheck · `cb6086f` tsc 清零 · `72229ad` D7 race 测试 · `dc46a83` 重建测试库 · `c476314` README 测试节 · `24496fe` test:unit · `9dc3b6a` Go 集成门闸对齐

**Parity D1–D8**：`2a33a6b` D8 15s 超时 · `8519078` D7 UPDATE rows · `f42b275` D6 定点 summary · `c1c33cb` D5 file part · `abf3ef1` D4 4MiB · `6b9e48c` D3 boundary · `cc293ce` D2 顶层 JSON · `b1dc306` D1 probe 400

**数据库 / 密钥**：`2dcbb2f` / `8083105` / `8c9c6d4` Neon 移除 · `4bd0296` sslmode · `8202983` rotate-test 删除

**文档 / 杂项**：`e197f8c` todo 审计行 · `9103724` / `014e2ef` / `b56b444` / `5ab74d4` README 数据模型 · `f159813` / `9f3056c` / `1237a32` / `a917468` 审计文档收尾 · `95e5a6e` probe 测试真相 · `f58f112` SUPPRESS_BOT_NOTIFICATION · `3d03f59` 清理 · `779f35e` lint 清零

完整列表以 `git log --since=2026-08-04` 为准（共 46 条）。

---

## 8. 仍待办 / 开放

- [ ] 手动验收清单续跑（后台双服务期间多轮 curl 已过，正式部署前再跑一轮）
- [ ] Dashboard 支出组件 / 网页录入 UI（既有待办，与今日收口无关）
- [ ] 复盘 `POST /api/log/review`：**已恢复开发**（2026-08-04 定案：单一接口 + `cadence` 枚举 + 自动附加 `review:{cadence}` tag + 保留 tag；规格 [`20260804-log-review.md`](20260804-log-review.md)；双端实现 + OpenAPI 待做）
- [ ] 记录编辑 API 废弃（2026-08-04 定案）：`PATCH /api/admin/records/:id` 一律 410 Gone，前端编辑 UI 移除（见 [`20260804-scope-closure.md`](20260804-scope-closure.md) 终止项 7）
