# Tag 设计讨论

> 创建日期：2026-08-05
> 性质：记录 tag 检索 / 分层 / 自动补全的产品交互设计讨论（含用户原话），供后续定案与实现。
> 触发：`docs/20260805-status-analysis.md` §2C 提出「周/月回顾首次 query 搜 review 记录」与当前 query tag 精确匹配冲突；讨论中扩展到 tag 分层检索与自动补全的普遍问题。

## 背景：现状

- 记录 `tags` 存 JSON 数组字符串（如 `["body:weight","morning"]`）。
- `GET /api/query?tag=X` 的 SQL 是 `tags LIKE '%"X"%'`——**带闭合引号的完整 tag 匹配**：`tag=body` **匹配不到** `body:weight`（`"body"` 字面不存在，`"body:weight` 的 `"body` 后跟 `:`）。
- 多层 tag 靠自然语言分层：`transaction_entry:income`、`body:weight`、`todo:in_progress`、`review:weekly`。
- 保留 tag 前缀（不可被普通写路径使用）：`transaction_entry`、`body:weight`、`todo`、`review`。

## 保留前缀 hint 文案（定案）

### hint 是什么

hint 是系统在「保留 tag 相关边界情况」下返回给 AI 的**纠错提示**，共两类：

1. **写拒绝错误文案**：AI 在通用写路径（如 `POST /api/log/numbers`）提交带保留前缀的 tag（`todo` / `transaction_entry` / `review`）→ 400。此时响应 `error` 携带本节讨论的 hint。
2. **检索空结果提示**：AI 用裸保留前缀查 `GET /api/query?tag=review`（该裸值永不落库，结果必空）→ 200 + 空 records + 可选 `hint` 字段（`query.ts:163`），指引用 `tag=review:*` 族通配。此 hint 只涉及 tag 名，**与端点路径无关，复数化永不波及**。

本节「复数化无需改 hint」专指**第 1 类**（写拒绝错误文案）。

### 新旧文案对照

| | 文案 | 代码位置 |
|--|--|--|
| **旧版**（`27d20f4`，已废弃） | `tag "X" is reserved; use POST /api/log/transaction for transaction line entries` | 硬编码**端点路径** |
| **新版**（定案，`ac54bc4` 已实现） | `tag "X" is reserved; use the dedicated log API for this record type` | `src/lib/tags.ts:61` / `faas/internal/tags/tags.go:56`（`reservedTagError`/`reservedTagError`，单一通用常量） |

### 旧版为何过时（hint 是行动指引，不是展示文案）

hint 给 AI 的语义是「**照此去做**」：AI 收到 `use POST /api/log/transaction` 后真的会去请求这个端点。因此 hint 一旦指向的端点被**改名/删除**（如复数化 `log/transaction` → `log/transactions`），hint 就指向 404 路径——**错误提示本身变成错误**，必须连带改文案。这就是「硬编码端点路径的 hint 与端点存在维护耦合」。

### 解耦后为何无需改

新版 hint **不指向任何具体端点**，AI 收到后自行查 OpenAPI（OpenAPI 恒为最新契约）找正确的专用端点。端点改名/新增都不影响这句文案的正确性 → 复数化 `log/transactions`、`query/transactions/summary` **不需要连带改 hint**。

### 澄清：不是省事，是已完成的独立改造

- hint 解耦本身就是一次**独立的架构改动**（去掉按前缀区分的硬编码路径、改为单一通用文案），已在 log/numbers 阶段实现并提交（`ac54bc4`）。
- 「复数化无需改 hint」= 复数化任务清单里**本就没有**「改 hint」这一项，因为该项在更早的提交已完成。
- 若现在仍是旧版硬编码文案，复数化时**必须**改（否则指引 404）；解耦只是让复数化少一处连带改动，不是跳过该做的工作。
- 验证：复数化验收时 `rg "use POST /api" src/ faas/` 全仓零残留，证明没有任何错误文案硬编码端点路径。

- 现状影响：`tag=body` 搜不到 `body:weight`；`tag=review` 搜不到 `review:weekly`（周/月回顾首查受阻）。

## 业界 tag 交互（用户提问）

> 回想业界常用的APP，里面的tag怎么设计的？用户搜索tag应该是什么行为？比如用户输入 a，是不是应该返回所有 a 开头的tag？

**结论（讨论整理）**：业界主流是「自动补全 + 精确确认」分离：

1. **补全阶段**：输入 `a` → 下拉建议所有 `a` 开头的 tag（这里才是前缀匹配）。
2. **确认阶段**：点选一个完整 tag → 过滤条件是精确 tag（非前缀）。
3. 分层 tag（`body:weight`）以层级树 / 面包屑呈现：点 `body` 展开子类，点具体项才过滤。

因此「输入 a 返回 a 开头 tag」应落在 **tag 自动补全**（tags 聚合端点加 `prefix` 参数），而非改动 query 的过滤语义。

## 候选过滤语义

| 方案 | SQL | `tag=body`→`body:weight` | 误抓 | 说明 |
|---|---|---|---|---|
| 现状（完整 tag） | `%"body"%` | ❌ | 无 | 点选精确 tag |
| 去尾引号（真前缀） | `%"body%` | ✅ | ❌ `bodyguard`/`bodybuilding` | 一字符改动，但 tag 名以参数开头的普通 tag 全被抓 |
| **双模式 OR（tag 族）** | `%"body"% OR %"body:%` | ✅ | 无（冒号边界） | 本体 ∪ `族名:*`，正好对应分层；`bodyguard`（无冒号非本名）不误抓 |

## 已定案

- **`GET /api/query?tag=X` 保持精确匹配**（业界默认：`tags LIKE '%"X"%'`，完整 tag 段）。
- **`GET /api/query?tag=X:*` 显式族通配**：参数尾缀 `:*` → SQL 改为 `tags LIKE '%"X:%'`（单 LIKE，去尾闭合引号、保留冒号），匹配所有 `X:` 前缀 tag。
  - `tag=review:*` → `review:weekly`、`review:monthly`…；**不**误抓 `reviewed`、裸 `review`、`bodyguard`（对 `tag=body:*`）。
  - 周/月回顾首查：`query?tag=review:*&from=…&to=…`。
  - URL 无需转义（`*` 是 RFC 3986 sub-delim）。
  - **`tag` 查询值仅两种合法形态**：纯 tag 名（无 `*`）或 `tag名:*`（`:*` 必须**同时存在**且位于单词末尾）。`work*`、`re*view`、`review:*:x`、裸 `*` → 400。
  - **400 文案**：`Invalid tag query "re*view": use a valid tag name or a family pattern "tag=review:*" (a single "*" at the end, prefix must be non-empty)`（统一一条，含正例；tag 内字面 `%`/`_`/`\` 照常走 `EscapeLikePattern`）。
- **`GET /api/query/tags` 排序改为「计数降序」**（`prefix` 搜索与全量一起改，行为统一可预测）；同计数次级按 tag 名升序（拟）。
- **`GET /api/query/tags` 返回形状改为数组 `{success, tags: [{tag, count}]}`**（元素 `tag`/`count` snake_case）。
  - 原因：Go `encoding/json` 序列化 `map` 恒为 key 升序，**map 形状无法表达计数降序**；改用 `[]struct{Tag, Count}` slice 保序。
  - 代价：现有 3 个前端消费方（`tag-multi-select`、`record-tag-chips`、`tags` 页）+ `fetchTags` 返回类型同步改。
- **`GET /api/query/tags?prefix=a` 新增参数**：真前缀 `startsWith(a)` 过滤（自动补全语义）；返回过滤后的计数降序数组。
  - `prefix` 是**纯字面前缀**，不做任何通配解析（`*` 按字面处理，如 `prefix=review:` 返回 `review:weekly` 等以 `review:` 开头的 tag）；`prefix=review:` 合法且可用于按族列举 tag（与 `tag=review:*` 过滤记录用途不同：前者补全 tag 名，后者过滤记录）。
- **裸保留前缀查询提示（hint）**：`query?tag=X` 且 `X` ∈ {`transaction_entry`, `review`, `todo`}（裸值永不被写入的保留前缀）时，返回 200 + 空 records + 可选 `hint` 字段。
  - 文案：`Use "tag=review:*" to match review records (the bare tag "review" is reserved and never stored)`。
  - **`body:weight` 除外**：裸 `body:weight` 就是真实落库 tag，查询可命中，不加 hint。
  - 多个 `tag=` 时（AND 交集）任一命中裸保留前缀即提示；hint 只指认**第一个**命中项（一次一个，AI 逐个修正）。
  - 交集语义下，一个恒空参数毒化整个查询，hint 指认毒源，AI 修正后即可命中。
- **不支持无层级前缀模糊（业界核实后定死）**：`tag=w*` 等**不提供**——`work` 与 `workout`（无冒号关系）不能一次通配，需分开精确查（或 `tags?prefix` 补全后逐个选）。业界共识：过滤 = 精确或层级通配（`X:*`），补全 = 前缀；无「任意前缀过滤」惯例（GitHub labels 精确名、Obsidian `tag:#a/*` 层级通配、Stack Overflow 补全前缀 + 过滤精确）。

## 待决策

1. ~~**过滤语义**~~：✅ 已定案 —— `tag=X` 精确；`tag=X:*` 显式族通配（中间 `*`、裸 `*` → 400）。
2. ~~**自动补全**~~：✅ 已定案 —— `tags?prefix=a` 真前缀过滤，计数降序数组 `[{tag, count}]`。
3. **层级呈现**：是否在 UI 用层级树 / 面包屑展示分层 tag？不影响后端语义（已定案），仅前端交互，待做 dashboard 时再议。

## tag 归一化（normalize / canonicalize）—— 修改 API 之二

> 定位：系统「修改 API 最终清单」两大操作之一（另一为单条 tag 增删，见 `docs/20260805-tags-add.md`）。目标是**搜索规范化**——`exercise`/`workout`/`training` 指向同一事物时合并为规范 tag，避免多重搜索。

```
POST /api/admin/tags/normalize（或 canonicalize）
{ "from": ["exercise", "workout", "training"], "to": "workout" }
→ 200 { success, updated: N }
```

### 语义（定案）

- **多源 → 单目标**：每条记录中若含 `from` 中任意 tag → 删掉这些、加 `to`（去重；tag 为**无序集合**，顺序不影响使用）。
- 是现有 `rename` 的**超集**（`from: [A], to: B` 即 rename A→B）→ 建议**替换** rename。
- 边界（只做机械校验，**不做语义判断**）：
  1. `from` 与 `to` 有交集（含 `to` 本身）→ 400（无意义操作）。
  2. `from` / `to` 含保留前缀（`body:weight`/`todo`/`transaction_entry`/`review`）→ 400。
  3. ~~父子关系检查~~ **不做**：`from: ["workout","workout:arm"]` 合并丢子类粒度，是 **AI 的语义决策**，系统信任 AI 不拦（备份兜底）。
  4. 去重：合并后同一记录重复 tag → 去重（机械操作，必须做）。
  5. 原子性：全表单事务 + advisory lock（对齐现有 `renameAcrossRecords`）。
  6. 响应 `{success, updated}`。
- 鉴权：**AdminToken**（全表破坏性，系统最大风险点；与补 tag 的 ApiToken 区分）。

### tag 顺序：懒惰原则（全系统统一）

tag 数组顺序只保留「创建时的用户意图 + 追加序」，**不刻意重排**：

1. **创建时**：保留 tag 在最前，用户 tags 按序在后（现状已如此：`todo:in_progress` / `review:{cadence}` / `body:weight` 在前）。
2. **新增 tag**（add 接口）：直接 **append 尾部**。
3. **normalize**：要删除的 tag **原地删、后续前移**；target 若已存在则**保持原位**，否则**尾加**。

优点：代码最简（append / 原地删，无重排）；顺序保留「创建序 + 追加序」弱语义；tag 本质无序，此顺序是「无额外成本」。

### 待定

- 路径名：`normalize` / `canonicalize` / `merge`；是否替换现有 `tags/rename`。
- 是否支持 `to` 为空（纯删除 from 系列）？——倾向不支持（删除单条 tag 用 add/remove 接口）。

## 实现待办（定案后）

- **query 通配**：双端 `parseRecordQueryParams` / `ParseRecordQueryParams` 解析 `tag` 尾缀 `:*`（校验：中间 `*` / 裸 `*` → 400，复用 `Invalid tag` 或新增文案）；`tag=X:*` 生成 `tags LIKE '%"X:%'`；OpenAPI `query.yaml` 描述、`like_escape_test.go` 相关断言同步。
- **tags 排序 + 形状 + prefix**：双端 `FetchTagCounts(prefix)` 返回 `[]TagCount{Tag, Count}`，计数降序、同名升序；Go `handleTags`、TS `aggregateTagCounts`、`fetchTags`、OpenAPI `TagsSuccess`（map → array）、3 个前端消费方、契约 fixture 同步改。
- **docs/20260805-status-analysis.md §2C**：更新为「已解决——`tag=review:*`」。

## 相关记录

- 周/月回顾首次检索依赖：`tag=review`（或双模式 OR 后的族匹配）需能抓到 `review:*`——见 `docs/20260804-ai-usage-discussing.md`「回顾 / 复盘：Review API 使用流程」。
- 保留前缀定义：`src/lib/tags.ts` / `faas/internal/tags/tags.go`。
