# DigitalTwin2026 状态分析

> 创建日期：2026-08-05
> 性质：现状盘点 + AI 使用规则落地情况 + 差距清单 + 下一步建议
> 相关：[`20260804-ai-usage-discussing.md`](20260804-ai-usage-discussing.md)（AI 使用规则，仅收录用户原话）

## 1. 仓库 / 工程状态

- 工作树干净；本地领先 origin 1 个提交（`801dd7c` AI 使用讨论文档，**未推送**）。
- CI 全绿（`c292cbc`，review 实现 + 测试）。
- review API 已完整落地：双端（`reviewdraft` / `logapi.CreateReview` / route/handler）、OpenAPI（`ReviewCadence` / `ReviewRequest`）、共享 fixture、契约测试、集成测试、路由级拒绝面测试。
- 连带完成：通知统一截断（>4000 字符 + 后缀）、`subjective_interpretation` → `ai_analysis` 全层改名、PATCH 编辑 API 彻底删除。

## 2. AI 使用规则 → 系统落地情况

### A. 系统已原生支持（无需改动）

- **模糊时间 happened_at**：系统接受任意合法带时区时间；下午→15:00、两天前→当天 12:00 等塌缩纯属 AI 判断，系统无需字段支持。
- **想法 / 计划 / 评价 → 现在时间；客观回忆 → 事件时间**：AI 行为规则，系统无约束。
- **双写流程**（记账/待办/体重）：`log/text` 与 `log/transactions` / `log/todo` / `log/body/weight` 都是独立端点，天然支持「先 log text 记原文 → 再调专用 API」。
- **日回顾流程**：`review` 记录原话 + `query` 查当天 + 按时间序组织输出（不落库）+ 点评 + 用户回应进 review——现有 API 组合可完全实现。
- **objective_context 用法**：字段已存在，语义无需改动。

### B. 明确缺口（未实现）

- **真实时间 API**：`docs/20260804-ai-usage-discussing.md` 首条需求「让模型查到现在真实的时间」——当前没有任何端点向客户端暴露服务器当前时间（`/api/query/summary` 内部用 now 但响应无时间串）。排第一的开发项。

### C. 规则与系统语义的冲突（需决策）

- **周/月回顾的「首次 query 搜 tag 含 review 的记录」与 query 匹配语义冲突**：✅ **已解决**（见 `docs/20260805-tag-design.md` 定案 + 实现）。
  - query 新增**族通配** `tag=X:*`（如 `tag=review:*` → 匹配 `review:weekly` 等全部 `review:` 前缀 tag；仅 `tag名:*` 合法，其它 `*` 形态 → 400 明确文案）。
  - 裸保留前缀（`transaction_entry`/`todo`/`review`）查询恒空时返回 200 + `hint` 提示用 `tag=X:*`（`body:weight` 例外——裸值即真实 tag，正常命中）。
  - 周/月回顾首查 = `query?tag=review:*&from=…&to=…`。
- **双写时 log text 不能带保留 tag**：`transaction_entry` / `todo` / `body:weight` 前缀会被 400 拒绝；双写时原文记录应不带 tag 或只带普通 tag——这条尚未写入 AI 使用文档。

## 3. 建议下一步

1. ~~**开发真实时间 API**~~：✅ 已完成（`cfc55a7`，`GET /api/time`）。
2. ~~**决策 query 的 review 检索语义**~~：✅ 已定案并实现（`tag=X:*` 族通配 + 裸保留前缀 hint，见 §2C）。
3. ~~**log/numbers 批量**~~：✅ 已完成（`log/number` → `log/numbers` 批量，entries + memo→objective_context；numberdraft/CreateNumberBatch/batch notify/OpenAPI）。
4. ~~**复数化剩余**~~：✅ 已完成（`POST /api/log/transactions` 与 `GET /api/query/transactions/summary` 改名；hint 已解耦无需改；逐类清单见 [`docs/20260805-pluralization.md`](20260805-pluralization.md)）。
5. **tags 增删接口**（`log/tags/add` + `remove`，见 `docs/20260805-tags-add.md`）——新接口。
6. **tag 归一化 normalize**（见 `docs/20260805-tag-design.md`，替换 rename）——新接口。
7. **把 AI 使用规则提炼成正式 AI 使用规范**（独立于讨论文档，供真实 LLM 客户端消费；含「双写时 log text 不带保留 tag」等系统约束）。
8. 推送本地领先的提交过 CI。
