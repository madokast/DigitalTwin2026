# DigitalTwin2026：`POST /api/log/review`（复盘记录）设计文档

> 创建日期：2026-08-04
> 状态：**已定案**（接口形态 / cadence / 键集 / 保留 tag / 通知 / 鉴权 / 记录编辑废弃全部锁定；代码待实现）
> 性质：Diataxis **explanation** + **how-to**；设计决策记录 + 契约锁定（实现以此为准）
> 相关：[`docs/20260728-fuzzy-time.md`](20260728-fuzzy-time.md) §7（复盘体系设计源头）、[`docs/20260729-schema-v1.md`](20260729-schema-v1.md) §3.2 / §6（旧 URL 形态，已作废）、[`docs/20260804-scope-closure.md`](20260804-scope-closure.md)（终止项 7：记录编辑 API 废弃）、根 [`AGENTS.md`](../AGENTS.md)、[`docs/20260801-api-layering.md`](20260801-api-layering.md)

## 0. 一句话结论

`POST /api/log/review` 单一接口；请求体 JSON（snake_case）带**必填** `cadence`（6 档枚举）+ 复盘全文等；后端**自动附加** `review:{cadence}` tag 落库；`review` / `review:*` 成为**保留 tag 前缀**，仅本接口可写；记录为普通记录（query / export / import 等通用能力自动适用）；ApiToken 鉴权；写成功照常全文通知。连带定案：记录编辑 API（Admin PATCH）**已彻底删除**（2026-08-04，效果 = 从未存在），前端编辑 UI 移除。

## 1. 背景与需求（为什么恢复）

### 1.1 设计源头

fuzzy-time §7「重大转向：以自然语言复盘为中心」：

- 复盘是**自然语言对话**（AI 读明细 + 与用户多轮讨论），不是 SQL 聚合；
- 复盘产出**是一条带 `review:*` tag 的普通记录**，与原始记录同表、无结构区别（§7.6）；
- `happened_at` 是复盘发生时刻（§7.6）；`review:*` tag **不带时间标识**（§7.8）；跨期复盘靠 AI 划时间范围 + tag 筛选（§7.9）；复盘与原始记录**绝不关联**（§7.7）。

### 1.2 恢复触发

`POST /api/log/review` 自 08-03 起暂停（`AGENTS.md` 旧条款：「待 JSON 蛇形统一后再议」）。08-03 蛇形统一已完成，恢复开发。

### 1.3 恢复前的文档审计发现

| # | 问题 | 处理 |
|---|------|------|
| 1 | 形态冲突：schema-v1 §3.2 / fuzzy-time §9.4 的 `/api/log/text/review/{周期}` URL 形态 vs 单一口径 `POST /api/log/review` | 定案单一接口（§2.1），旧形态文档标注作废 |
| 2 | fuzzy-time §7.3 中文 tag 示例（`["周复盘","2026-W30"]`）与 tag pattern（拒中文）、§7.7 `review:*` 定案矛盾 | 文档示例改 `review:*` 形式；代码不动 |
| 3 | 旧字段名 `value_text` / `value_numeric` 在 fuzzy-time §7 / schema-v1 §3.3 残留 | 文档改现行 `raw_content` / `numeric_value` |
| 4 | 规格空白：period 表达、键集、通知、鉴权均未定义 | 本文档 §3–§4 全部锁定 |

## 2. 接口形态决策

### 2.1 候选对比

| 候选 | 形态 | 否决/采纳理由 |
|------|------|--------------|
| A（旧设想） | `/api/log/text/review/daily|weekly|monthly|{周期}` | 周期写死在 URL，tag 语义靠 URL 隐含；契约面随周期数膨胀；与现有 `/api/log/*` 平铺结构不符；OpenAPI 每周期一份 path，冗余 |
| **B（定案）** | **`POST /api/log/review` 单一接口 + 请求体 `cadence`** | 单一契约、周期作为数据而非路径；OpenAPI 一份 path + 一个 enum；后端自动附加 `review:{cadence}`，语义明确且集中 |

### 2.2 cadence 枚举（锁定）

```
daily | weekly | monthly | quarterly | semiannually | yearly
```

- 半年值最终定为 **`semiannually`**（与 `-ly` 后缀族一致；fuzzy-time §8.2 S18 旧写法 `halfyear` 作废）；
- **必填**；**严格小写、不 trim**（`"WEEKLY"` / `" Weekly"` → 400，与 tag 不 trim 原则一致）；
- 非法值错误回显**全部可用值**。

### 2.3 保留 tag（锁定）

- `review` / `review:*` 加入保留前缀（TS `RESERVED_TAG_PREFIXES` / Go `tags`），**仅本接口可写**；
- 客户端显式传 `review:*` → 400（hint：`use POST /api/log/review for review records`）；
- 后端落库自动附加 `[review:{cadence}, ...clientTags]`（客户端不可能传 `review:*`，无重复）；
- `review:*` 由此从「语法示例」（scope-closure §2.4 旧述）升级为**语义约定**。

## 3. 契约（锁定）

### 3.1 端点

| 项 | 值 |
|----|-----|
| 方法 / 路径 | `POST /api/log/review` |
| 鉴权 | ApiToken（`verifyApiAccess`，与 `/api/log/*` 一致） |
| 成功 | `201`，`{ success: true, record: Record }`（与 `/api/log/text` 同包络） |
| 通知 | 写成功即 `scheduleBestEffortNotify(() => notifyRecordInserted(record))`（**全文**；>4000 字符由通知层统一截断——`notify_user` / `NotifyUser` 入口，全类型共用，保留前 3987 字符 + `\n… (truncated)`，总长 4000，Telegram 4096 / QQ 同类留余量；共享 fixture `testdata/notify-truncate-cases.json`） |

### 3.2 键集（`LOG_REVIEW_KEYS`，不复用 `RECORD_DRAFT_KEYS`）

strict unknown-key：未知键 → 400。

| 键 | 必填 | 校验 |
|----|------|------|
| `happened_at` | **必填** | `parseHappenedAt`：ISO 8601 带显式时区（Z / ±HH:MM / ±HHMM）；写 `utc_offset` 隐列（`docs/20260803-utc-offset.md`） |
| `cadence` | **必填** | 枚举 §2.2；缺省 / 非法 → 400 |
| `raw_content` | **必填** | `requireTrimmedText`：trim 后入库；空串 / 空白 → 400。复盘全文（可含段落换行） |
| `objective_context` | **必填** | `requireTrimmedText`：AI 一句话客观说明（如 `Weekly review covering 2026-08-03..2026-08-09`）。对齐全部写路径惯例；`objective_context` 列 NOT NULL |
| `ai_analysis` | 可选 | `optionalTrimmedNullable`：省略 / null → null；`""` / 空白 → 400 |
| `tags` | 可选 | 客户端附加 tag；空数组合法；含 `review` / `review:*` → 400（保留前缀） |

**禁止键**（unknown key → 400）：

- `numeric_value`：复盘是**纯文本记录**（fuzzy-time §7.4 的「偶尔数值」揉在 `raw_content` 文本里）；落库恒 NULL，由 `raw_content` 满足 `chk_raw_content`；
- `utc_offset`（隐列，同其他路径）。

### 3.3 请求示例

```json
{
  "happened_at": "2026-08-09T19:00:00+08:00",
  "cadence": "weekly",
  "raw_content": "This week I slept better and finished the report...",
  "objective_context": "Weekly review covering 2026-08-03..2026-08-09",
  "tags": ["work"]
}
```

### 3.4 错误（英文，双端字节一致）

- `Missing required field: happened_at` / `cadence` / `raw_content` / `objective_context`
- `Invalid cadence: must be one of daily, weekly, monthly, quarterly, semiannually, yearly`
- `raw_content must not be blank` 等共享 helper 文案（`draft.ts` / `draft.go`）
- `tag "review:weekly" is reserved; use POST /api/log/review for review records`

### 3.5 落库与响应

- `tags` = `[review:{cadence}, ...clientTags]`；`numeric_value` = NULL；`objective_context` / `ai_analysis` / `happened_at` + `utc_offset` 同普通记录；
- 响应 = 标准 Record JSON：snake_case；`tags` 数组（含 `review:*`）；`happened_at` 带录入规范区；`numeric_value` null 时省略键（现行规则）。

## 4. 语义（沿用 fuzzy-time §7）

- `review:{cadence}` 六档：`review:daily` / `review:weekly` / `review:monthly` / `review:quarterly` / `review:semiannually` / `review:yearly`
- tag 不带时间（§7.8）；跨期检索（§7.9）不变：AI 划范围 + `tag=review:monthly` 筛选 + 读 `raw_content` 确认
- 与原始记录不关联（§7.7）
- 通用能力自动适用：query（tag AND / 排序 / 分页）、export（正常导出）、import（**可写 `review:*`**——`recordjsonl` 不调 `assertNoReservedTags`，与 todo / transaction 保留 tag 同规则）、tag rename（from / to 不得为 `review:*`）

## 5. 记录编辑 API 删除（连带定案）

`PATCH /api/admin/records/:id` **已彻底删除**（2026-08-04，适用于**一切**记录；OpenAPI、双端代码、前端编辑 UI、测试全部移除，效果 = 该 API 从未存在）。详见 scope-closure 终止项 7：

- 直接诱因：保留 tag 记录（`todo:*` / `review:*` / `transaction_entry:*` / `body:weight:*`）的 tags 含保留前缀，前端编辑提交完整 tags 必然触发保留前缀 400——保留 tag 记录天然不可安全编辑；
- 与其按记录类型分叉编辑策略，不如统一删除编辑，语义最简单；
- 纠错路径：export（NDJSON）→ 外部修改 → import upsert 覆盖。

## 6. 双端同构（对齐 api-layering）

| Next | Go FaaS |
|------|---------|
| `src/lib/reviewdraft.ts`（`LOG_REVIEW_KEYS` / `CADENCES` / `parseReview`） | `faas/internal/reviewdraft/reviewdraft.go`（`ParseReview`） |
| `src/app/api/log/review/route.ts`（ApiToken + notify） | `faas/internal/logapi` review handler + `httpx` 路由（同 `/api/log/text`） |

## 7. OpenAPI / 测试

- `openapi/paths/log.yaml`：新增 `/api/log/review`（请求 `ReviewRequest`；响应 `Record`；403 ApiToken）
- `openapi/components/schemas.yaml`：`ReviewCadence`（enum 六档）、`ReviewRequest`
- fixtures / contract tests / testdata：cadence 缺省 / 非法值 / 大小写、`review:*` 保留 tag 拒绝（log/text、rename）、自动附加断言、import 可写 `review:*`、双端集成一致
- 门闸：`npm run openapi:lint`、`npm run test:unit`、`npm run test:integration`、`cd faas && go test`

## 8. 实现注意点（开工前核对，2026-08-04 讨论锁定）

### A. 保留 tag `review` 的连锁影响

1. **拒绝面自动覆盖**：`review` 加入 `RESERVED_TAG_PREFIXES`（TS `src/lib/tags.ts` / Go `faas/internal/tags`）后，通用 log/text、rename from/to、admin 草稿自动拒绝 `review` / `review:*`——**但 import 例外**（`recordjsonl` 不调 `assertNoReservedTags`），review 记录可正常导入。
2. **query 不受影响**：`tag=review:weekly` 过滤照常工作（查询不拒保留 tag）。
3. **tags 测试矩阵补齐**：`review`✓、`review:weekly`✓、`review:weekly:x`✓、`reviewpoint`✗（冒号边界，防误伤）、既有 `transaction_entrypoint` / `todolist` 误伤回归。
4. **组装后的 tags 不能再过校验**：`CreateReview` / `createReview` 自动附加 `review:{cadence}` 发生在 `ParseReview` / `parseReview` 校验**之后**，否则服务端组装值会把自己拒绝。
5. **todo 变形判定无冲突**：`ShouldDeformTodoRecordTags` / `shouldDeformTodoRecordTags` 只看 `todo:*`，review 行不变形。

### B. 校验细节

6. **cadence 缺失 vs 非法两条文案**：`Missing required field: cadence`（键缺 / null）vs `Invalid cadence: must be one of daily, weekly, monthly, quarterly, semiannually, yearly`（值不在枚举）——Go 侧注意 nil 分支与值分支。
7. **严格小写、不 trim**：`"WEEKLY"` / `" weekly"` / `"weekly2"` → Invalid cadence；共享 fixture `testdata/review-cadence-cases.json`（accept 6 值 / reject 若干）。
8. **禁键**：`numeric_value` / `utc_offset` → unknown key 400（strict）；`ai_analysis` 可选（`ai_analysis must not be blank` 沿用 `OptionalTrimmedNullable` / `optionalTrimmedNullable` helper）。
9. **空白 `raw_content` 拒绝**：`raw_content must not be blank`（`RequireTrimmedText` / `requireTrimmedText`）；复盘长文可含段落换行，trim 只去首尾空白。

### C. 响应与写入

10. **`ai_analysis` null 时恒返回键**：`Record.ai_analysis` 是 `string | null` **非省略键**（与 `numeric_value` 的 null 省略不同）——review 响应同样显式输出 `ai_analysis: null`。
11. **201 + `{success, record}`** 照抄 `/api/log/text`；响应 `tags` 数组 = `[review:{cadence}, ...clientTags]`，`review:{cadence}` 在最前。
12. **`happened_at` → `utc_offset` 隐列**：`ParseHappenedAt` / `parseHappenedAt` 抽 offset 并规范化（紧凑 `+0800` → `+08:00`）。
13. **通知**：响应后 `scheduleBestEffortNotify(() => notifyRecordInserted(record))`（全文；>4000 字符统一截断已就绪，见 §3.1）；telegram 通知输出 `ai_analysis: ...` 标签（2026-08-04 改名后口径）。

### D. 双端对齐

14. **Go 新增三处**：`faas/internal/reviewdraft`（`ParseReview` / `NormalizedReview` / cadence 常量）+ `faas/internal/logapi` 的 `CreateReview`（INSERT … RETURNING，**参数顺序盯紧**，与 rename 坑 #4 同类）+ `faas/internal/httpx/server.go` 路由注册 `POST /api/log/review`（ApiToken 由 `withAuth` 自动覆盖；CORS 方法表已有 POST）。
15. **TS 新增两处**：`src/lib/reviewdraft.ts`（`LOG_REVIEW_KEYS` / `CADENCES` / `parseReview`）+ `src/app/api/log/review/route.ts`。
16. **错误文案字节一致**：新文案 3 条（§2.3）+ 沿用 helper 文案（`raw_content must not be blank` / `ai_analysis must not be blank` / `tags must be an array of strings` / `Invalid tag: ...`）。

### E. 测试矩阵

17. reviewdraft 单测（TS / Go 同读共享 fixture）；route 集成（成功 201 / tags 自动附加与顺序 / `happened_at` 带区 / 通知 schedule / 全部错误路径）；Go httpx 同矩阵；契约 fixtures（`review-request-valid.json` + invalid cadence 错误样例）；`openapi/paths/log.yaml` + `ReviewCadence` / `ReviewRequest` schema。

### F. 文档收尾

18. `docs/20260801-api-layering.md` 的 `reviewdraft` 行「待实现」标注 → 已落地；`docs/20260804-development-log.md` 待办勾选；本文档 §9 实施计划阶段勾选。

## 9. 实施计划（分阶段，每阶段门闸自洽）

| 阶段 | 内容 | 状态 |
|------|------|------|
| 1 | 保留 tag 双端：`RESERVED_TAG_PREFIXES` + Go `tags` 增 `review`，hint 文案；`tags.test.ts` / Go 测试补用例 | ✅ 已完成 |
| 2 | `reviewdraft` 双端（键集 / cadence 枚举 / 校验 / 自动附加 tag 组装） | ✅ 已完成 |
| 3 | `route.ts` + Go handler + 路由注册 + 通知（全文；超 4000 字符截断，见 §3.1） | ✅ 已完成 |
| 4 | PATCH 删除：双端路由 / handler / OpenAPI 路径 / 前端编辑 UI / 测试全部移除 | ✅ 已完成 |
| 5 | OpenAPI + fixtures + 契约测试；review 双端集成测试 | ✅ 已完成 |
| 6 | 门闸全绿（lint / typecheck / openapi:lint / unit / integration / go test） | ✅ 已完成 |

## 10. 文档同步（2026-08-04 已完成）

- 根 `AGENTS.md`：暂停条款 → 指向本文档
- `docs/20260804-scope-closure.md`：终止项 7（PATCH 删除）+ §2.7 理由；§3 review 恢复 + 保留 tag 升级为语义约定
- `docs/20260803-utc-offset.md`：6 处「复盘仍暂停」更新
- `docs/20260728-fuzzy-time.md`：顶部 pointer；§7.3 / §7.6 中文 tag 示例 → `review:*`；§7.4 / §7.6 / §7.9 / §8.2 S20 / §9.4 旧字段名 → 新名；§9.4 复盘 URL 形态标注作废
- `docs/20260729-schema-v1.md`：顶部 pointer；§3.2 URL 形态作废；§3.3 / §6.2 / §6.3 字段名与 tags 语义更新
- `docs/20260804-development-log.md`：待办更新（review 恢复 + PATCH 废弃）
