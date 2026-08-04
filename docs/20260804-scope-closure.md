# DigitalTwin2026 范围收口：明确不做清单

> 创建日期：2026-08-04
> 状态：**已定案**（一次性收口，终止项不再进入开发计划，不再重新讨论）
> 性质：范围决策
> 相关：`docs/20260727-initial-vision.md`、`docs/20260728-fuzzy-time.md`、`docs/20260803-records-import-export.md`

## 0. 目的

把若干"待定 / 规划中 / 有意不做"事项**正式终止**，明确写死为"不做"：

- 终止项不需要（也不允许）被"以后再开"；
- 历史文档正文保留当时原样（不做追溯改写），以本文档为准；
- 若未来出现**新的、未被本文档覆盖**的需求，按新需求流程另行评估，不因本文档自动排除。

## 1. 终止清单

| # | 事项 | 原文出处 | 决定 |
|---|------|---------|------|
| 1 | 时间段 `happened_until` 字段 | initial-vision §4.2 / §7.1 / §7.2 草案字段 | **不做** |
| 2 | LLM 接入层（tools / MCP / 对话即录入客户端） | initial-vision §8.1–8.3 | **不做**（HTTP 是唯一契约） |
| 3 | 设备上报（设备协议 / SDK / 契约文档） | initial-vision §8.3 | **不做**（设备 = HTTP 客户端） |
| 4 | `source:*` 元 tag 语义约定 | initial-vision §7.4 | **不定案、不引入** |
| 5 | records 数值聚合 API（S3 体重趋势等） | fuzzy-time §5.7（§9.3 账单例外已落地） | **不做**（维持"聚合让 AI 自己算"） |
| 6 | 图表 / 可视化（v1 + v2）与 import/export gzip | fuzzy-time §7.10；records-import-export「一期无 gzip」 | **不做**（v2 规划一并作废） |
| 7 | 记录编辑 API `PATCH /api/admin/records/:id` | 现行 API（OpenAPI `admin.yaml`） | **已删除**（2026-08-04 定案，配合复盘 API 恢复）：路由 / handler / OpenAPI 路径 / 前端编辑 UI / 测试**全部移除**，效果 = 该 API 从未存在；纠错走 export → 修改 → import 或专用接口 |

## 2. 逐条决定与理由

### 2.1 `happened_until`（时间段）—— 不做

- 不新增该列；记录表保持单点 `happened_at`，"时间段"不再作为记录模型概念。
- 理由：该字段的唯一消费方是 S1 睡眠时长 / S2 时间分配统计，而 records 服务端聚合已终止（见 2.5），时间段没有机械统计消费方；时长信息由 `raw_content` 文本自然承载（如"8 点到 9 点"），不为此加列。
- 连带：**S1、S2 一并终止**，不再排期。
- 硬约束提示：即使未来要加，也必须改基准 `0000` + drop 重建，禁止增量 migration（根 `AGENTS.md`）。

### 2.2 LLM 接入层（tools / MCP / 对话即录入客户端）—— 不做

- 不开发任何 LLM 客户端、tools / MCP 包装层、对话编排服务。
- **HTTP API 是唯一对外契约**：任何 LLM / 客户端一律直接 HTTP 调用现有 `/api/log/*`、`/api/query/*`、`/api/admin/*`。
- 理由：LLM 由用户侧自行选择，任何支持 HTTP 的对话应用均可接入，本项目不绑定具体 LLM 供应商；工具调用协议迭代快，后端跟进成本高、收益低；对话编排属于用户侧的 LLM 应用，不在本仓库范围内。
- 连带关闭 initial-vision §8.3 三个待定问题：
  - 协议形态 → **定案：普通 HTTP**；
  - 设备与 AI 是否同接口 → **定案：同一套 HTTP API，无差别**；
  - 后端语义校验回怼 → 依赖现有 4xx + 英文错误文案（已有），不扩展专用"回怼"机制。

### 2.3 设备上报 —— 不做

- 不开发专门设备协议、设备端 SDK、设备契约文档。
- 理由：设备即 HTTP 客户端，直接调用现有 API；当前无真实设备硬件可供联调，避免没有消费方的设计投入。
- `source:device` 仅作为 tag 语法示例保留在 OpenAPI（`TagName` examples），**不代表语义约定**（见 2.4）。

### 2.4 `source:*` 元 tag 约定 —— 不引入

- 不引入 `source:` 命名空间的语义约定，不要求 AI 为记录追加来源元 tag。
- 理由：来源信息没有消费方（无设备上报、无来源统计）；tag 保持纯内容语义。
- `source:device` 仍只是 `TagName` 语法（`xxx:yyy` 分段）的合法示例之一，与 `review:weekly` 同性质——**语法示例 ≠ 语义约定**。

### 2.5 records 数值聚合 API —— 不做

- records 不做服务端聚合，维持 fuzzy-time §5.7 定案"聚合让 AI 自己算"（个人数据量级下，AI 拉明细自行汇总成本可接受）。
- **保留已实现特例**：`GET /api/query/transaction/summary`（账单聚合）为 fuzzy-time §9.3 定案的机械统计例外，已落地、不收回。
- S3 体重趋势等依赖数值聚合的需求随之**不再提供机械统计**，由 AI 在对话中自行计算。

### 2.6 图表 / 可视化与 gzip —— 不做

- 前端 v1 不做图表 / 折线图 / 可视化分析（维持 fuzzy-time §7.10）。
- **fuzzy-time §7.10 的 "v2 前端：图表与可视化"规划作废**，不再有 v2 图表规划。
- import / export 不实现 gzip 压缩（records-import-export 文档"一期无 gzip"升级为永久决定）。

### 2.7 记录编辑 API（`PATCH /api/admin/records/:id`）—— 已删除

- 2026-08-04 随复盘 API 恢复一并定案：编辑 API **彻底删除**——路由 / handler / OpenAPI 路径 / 前端编辑 UI / 相关测试全部移除，**效果 = 该 API 从未存在**（无 410 残留契约，未注册的 PATCH 走框架 404/405）。
- 直接诱因：保留 tag 记录（`todo:*` / `review:*` / `transaction_entry:*` / `body:weight:*`）的 tags 含保留前缀，前端编辑提交完整 tags 必然触发保留前缀 400——保留 tag 记录天然不可安全编辑；与其按记录类型分叉编辑策略，不如**统一删除编辑**，语义最简单。
- 纠错路径：export（NDJSON）→ 外部修改 → import upsert（覆盖）；或删除后重录（无 DELETE 接口，同样经 import 覆盖语义）。
- 连带：`parseRecordDraft` / `record.Update` / 前端编辑页等编辑链全部清理（2026-08-04 两个提交完成）。

## 3. 不受影响的现有能力

以下能力与本收口无关，**保持现状**：

- 复盘体系（fuzzy-time §7）：已恢复开发，规格见 [`20260804-log-review.md`](20260804-log-review.md)（`POST /api/log/review` 单一接口 + `cadence` 枚举）。`review` / `review:*` 为**保留 tag 前缀**（仅复盘接口可写），属语义约定——不再是「语法示例 ≠ 语义约定」性质（对比 §2.4 的 `source:*`）。
- 交易聚合例外（transaction summary）：已落地，保留。
- 录入入口总原则（initial-vision §8.1）：无人工表单，AI / 设备经 HTTP 录入——本收口只是明确"本项目不写 LLM / 设备客户端"，**入口原则不变**。

## 4. 历史文档一致性

| 文档 | 处理 |
|------|------|
| `docs/20260727-initial-vision.md` | 头部变更提示追加本文档引用（正文保留原样） |
| `docs/20260728-fuzzy-time.md` | 头部变更提示追加本文档引用（正文保留原样；§7.10 v2 图表、§5.7 以本文档为准） |
| 根 `AGENTS.md` | 追加范围收口引用条目，防止终止项被重新打开 |
