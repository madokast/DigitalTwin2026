# Tag 设计讨论

> 创建日期：2026-08-05
> 性质：记录 tag 检索 / 分层 / 自动补全的产品交互设计讨论（含用户原话），供后续定案与实现。
> 触发：`docs/20260805-status-analysis.md` §2C 提出「周/月回顾首次 query 搜 review 记录」与当前 query tag 精确匹配冲突；讨论中扩展到 tag 分层检索与自动补全的普遍问题。

## 背景：现状

- 记录 `tags` 存 JSON 数组字符串（如 `["body:weight","morning"]`）。
- `GET /api/query?tag=X` 的 SQL 是 `tags LIKE '%"X"%'`——**带闭合引号的完整 tag 匹配**：`tag=body` **匹配不到** `body:weight`（`"body"` 字面不存在，`"body:weight` 的 `"body` 后跟 `:`）。
- 多层 tag 靠自然语言分层：`transaction_entry:income`、`body:weight`、`todo:in_progress`、`review:weekly`。
- 保留 tag 前缀（不可被普通写路径使用）：`transaction_entry`、`body:weight`、`todo`、`review`。
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

## 实现待办（定案后）

- **query 通配**：双端 `parseRecordQueryParams` / `ParseRecordQueryParams` 解析 `tag` 尾缀 `:*`（校验：中间 `*` / 裸 `*` → 400，复用 `Invalid tag` 或新增文案）；`tag=X:*` 生成 `tags LIKE '%"X:%'`；OpenAPI `query.yaml` 描述、`like_escape_test.go` 相关断言同步。
- **tags 排序 + 形状 + prefix**：双端 `FetchTagCounts(prefix)` 返回 `[]TagCount{Tag, Count}`，计数降序、同名升序；Go `handleTags`、TS `aggregateTagCounts`、`fetchTags`、OpenAPI `TagsSuccess`（map → array）、3 个前端消费方、契约 fixture 同步改。
- **docs/20260805-status-analysis.md §2C**：更新为「已解决——`tag=review:*`」。

## 相关记录

- 周/月回顾首次检索依赖：`tag=review`（或双模式 OR 后的族匹配）需能抓到 `review:*`——见 `docs/20260804-ai-usage-discussing.md`「回顾 / 复盘：Review API 使用流程」。
- 保留前缀定义：`src/lib/tags.ts` / `faas/internal/tags/tags.go`。
