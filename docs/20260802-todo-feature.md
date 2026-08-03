# DigitalTwin2026：任务清单 / Todo（GTD）

> 创建日期：2026-08-02  
> 状态：讨论定稿；**Phase 1（保留前缀 `todo`）已落地**；**Phase 2（创建 `POST /api/log/todo`）已落地（2026-08-03）**；**Phase 3（transition + 审计 + notify）已落地（2026-08-03）**；Phase 4 尚未开发（§9 中 transition 成功响应形状与 notify 范围两项**已收**；实现分期见 **§10**）  
> 性质：个人项目；偏 GTD 个人待办  
> 相关：`docs/20260729-schema-v1.md`（append-only / tags）、账单与体重的「保留 tag + 专用 API」先例（`transaction_entry` / `body:weight`）

## 0. 目标与非目标

**目标**

- 用专用 API 创建待办；正文进 `value_text`；代表状态用保留 tag `todo:{state}`。
- AI 用现有 **`GET /api/query`**（如 `?tag=todo:in_progress`）拉清单并拿到 `id`（UUID），**不**新增 list/趋势类 API。
- 用专用 **transition** API 改状态：只替换代表状态 tag，同事务写一条英文审计 `log/text`。
- 四态任意互转，**不做**复杂状态机。

**非目标（本篇不设计）**

- 前端清单 UI / 看板。
- due date、优先级、子任务、项目树、指派人。
- 独立 todo 表（仍落在现有 `records`）。
- 查询侧「同日取最新」等额外聚合。

---

## 1. 状态与保留 tag

### 1.1 四态（字面量固定，勿用口语 doing/done）

| 状态 | 代表 tag | 含义（简述） |
|------|----------|--------------|
| `in_progress` | `todo:in_progress` | 进行中（**创建时的唯一初始状态**） |
| `completed` | `todo:completed` | 已完成 |
| `cancelled` | `todo:cancelled` | 已取消 |
| `paused` | `todo:paused` | 已暂停 |

集合记为 **TodoState** = `{ in_progress, completed, cancelled, paused }`。

### 1.2 保留前缀与「定死」的五个 tag

- 在 `RESERVED_TAG_PREFIXES` 增加 **`todo`**（规则同现有：`tag === "todo"` 或 `tag.startsWith("todo:")`）。
- 禁止经由 `log/number`、`log/text`、`log/transaction`、`log/body/weight`、Admin rename 的 from/to 等路径写入或改名为 `todo` / `todo:*`。
- 仅 **`POST /api/log/todo`** 与 **`POST /api/log/todo/transition`** 可写入带此前缀的 tag。

**系统只会写入的闭集（五个字面量，定死）：**

| tag | 用途 |
|-----|------|
| `todo:in_progress` | 待办 · 进行中 |
| `todo:completed` | 待办 · 已完成 |
| `todo:cancelled` | 待办 · 已取消 |
| `todo:paused` | 待办 · 已暂停 |
| `todo:transition` | 审计行（仅 transition 插入） |

- **录入侧必须严禁**：客户端不得自带任一 `todo` / `todo:*`；服务端除上表五者外**永不**再发明其它 `todo:*`（例如禁止将来随手加 `todo:blocked` 而不改本文与双端）。创建只写 `todo:in_progress`；transition 只在四态间替换；审计只写 `todo:transition`。
- **查询侧可略放宽**：`GET /api/query` 的 tag 过滤、以及「是否按待办行做 JSON 变形」的判定，允许对脏数据稍宽容（例如历史误写、手工改库），但 **Next 与 Go 必须共用同一套判定规则与共享 fixture**，宽松程度字节级一致，禁止一端严一端松。

### 1.3 行类型约定

| 行种类 | tags 特征（录入后的正常形态） | 说明 |
|--------|------------------------------|------|
| **待办行** | 恰好一个四态 tag，可另有非保留额外 tags | 创建 / transition 的操作对象；对外 JSON 变形（§5.1） |
| **审计行** | `["todo:transition"]`（可无其它 tag） | **禁止** transition；对外 **不**变形 |

**录入 / transition 判定（严）**：待办行 = 存在**恰好一个**四态 tag、且**不含** `todo:transition`；否则按 §3.3 报错。

**查询变形判定（可略宽，双端同宽）**：建议共享函数（示例，实现时定死并测）：tags 中**至少含一个**四态 tag → 按待办行输出 `created_at`/`content`；否则若含 `todo:transition` 或其它 → 默认 Record JSON。若一行同时脏到「四态 + transition」并存，按共享规则选边（推荐：**有四态则按待办变形**），写入 fixture，Node/Go 同测。

---

## 2. 创建：`POST /api/log/todo`

### 2.1 路径与权限

- 路径：`POST /api/log/todo`
- 鉴权：与其它 log 相同（**AI token 与 Admin token** 均可）

### 2.2 请求体（`additionalProperties: false`）

为让 AI 写 JSON 更自然，**创建**接口使用别名键；落库仍映射到 records 既有列。

| JSON 字段 | 必填 | 落库列 | 说明 |
|-----------|------|--------|------|
| `created_at` | 是 | `happened_at` | 格式与其它 API 的 `happened_at` 相同（ISO 8601 带时区）；**不传 → 400**。请求里**不要**再传 `happened_at`（未知键拒绝） |
| `content` | 是 | `value_text` | 待办正文（清单内容）；非空字符串。请求里**不要**再传 `value_text` |
| `objective_context` | 是 | `objective_context` | 创建时的客观背景；**不传 → 400** |
| `subjective_interpretation` | 否 | 同名 | 主观解释 |
| `tags` | 否 | `tags` | 额外 tags；省略或 `[]` 均可。**不得**含任何保留 tag（含 `todo` / `todo:*`） |
| `suppress_notification` | 否 | （不落库） | 默认 `false`；语义同其它 log |

`value_number`：**不接受**。`happened_at` / `value_text` 作为请求键名亦**不接受**（避免与别名混用）。

示例：

```json
{
  "created_at": "2026-08-02T10:00:00+08:00",
  "content": "Buy milk",
  "objective_context": "weekend grocery list",
  "tags": ["errand"]
}
```

### 2.3 落库

- `happened_at` ← `created_at`；`value_text` ← `content`；`value_number` = null。
- tags = `["todo:in_progress", ...clientTags]`（**保留状态 tag 在前**；额外 tags 顺序保持客户端顺序，双端固定同一算法）。
- 成功：`201` + `{ success, record }`，其中 **`record` 必须按待办行对外形状变形**（`created_at` / `content`，见 §5.1），与 query 一致。
- 通知：成功后 `notify_user`（best-effort）；`suppress_notification: true` 则跳过。

### 2.4 与通用 text 的关系

客户端**不能**用 `POST /api/log/text` + 自带 `todo:in_progress` 伪造待办（保留 tag 拒绝）。必须走本 API。

---

## 3. 流转：`POST /api/log/todo/transition`

### 3.1 路径与权限

- 路径：`POST /api/log/todo/transition`
- 鉴权：AI token 与 Admin token 均可（现实约束：由 AI 管理 todos，故对 AI 开放这条「改 tag」能力）。

### 3.2 请求体（`additionalProperties: false`）

流转**不用** `created_at` / `content` 别名，避免与「创建时刻 / 正文」混淆；时间键保持与其它 log 一致的 `happened_at`。

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 待办行 UUID |
| `target` | 是 | ∈ TodoState：`in_progress` \| `completed` \| `cancelled` \| `paused` |
| `happened_at` | 是 | 审计行与本次流转的时间锚点（ISO 8601 带时区）；**不传 → 400** |
| `suppress_notification` | 否 | 默认 `false`；跳过本请求触发的 notify |

**不**接受 `created_at`、`content`，也不接受改待办 `value_text` / `objective_context` / 额外 tags 的字段——流转**只**改代表状态 tag，其它字段（含其它 tags）一律不动。

### 3.3 校验顺序与错误文案（英文，AI 可读；四类必须可区分）

建议严格按序短路，便于 AI 对症修改请求：

| 顺序 | 条件 | HTTP | `error` 全文（定稿实现时双端字节一致） |
|------|------|------|----------------------------------------|
| 1 | `id` 对应行不存在 | 404 | `to-do not found` |
| 2 | 行存在，但**不是**待办行（无四态代表 tag；含纯审计行、普通 text/number 等） | 400 | `record is not a to-do` |
| 3 | 行是审计行特征（tags 含 `todo:transition` 且无四态代表 tag），或实现上并入「不是待办」——**必须禁止对审计流转** | 400 | `cannot transition a to-do audit record` |
| 4 | 当前代表状态 **等于** `target` | 400 | `to-do is already in target state` |

说明：

- 若实现把「审计行」检测并入步骤 2，仍须保证步骤 3 的文案在「明确是审计行」时出现，或文档约定：审计行统一返回 `cannot transition a to-do audit record`，其它非待办返回 `record is not a to-do`（**两种文案都保留**，不要吞成一句）。
- `target` 非法（非四态字面量）→ 另用普通校验文案（如 `target must be one of: in_progress, completed, cancelled, paused`），与上表四类并列，不挤占上表语义。

### 3.4 状态机：故意放开

- **任意** TodoState → **任意其它** TodoState，只要 `target ≠ current`。
- 不校验「paused 才能 Resume」等；注释写明：**无业务边约束，仅校验四态集合与 target 不同**。
- 实现上：从 tags 数组找到唯一的 `todo:{current}`，替换为 `todo:{target}`；**其余 tags 原样保留**。

### 3.5 同事务两步（必须原子）

在**同一 DB 事务**中：

1. **UPDATE** 待办行：仅 tags 中的代表状态 tag 变为 `todo:{target}`；`value_text` / `happened_at`（原行）/ `objective_context` / 其它 tags / 等字段不变。
2. **INSERT** 一条审计记录（见 §4）。

任一步失败 → 整单回滚。成功后 HTTP 层再 best-effort `notify_user`（除非 suppress）；通知失败不影响已提交事务。

成功响应（**已拍板**）：HTTP **`200`**（不用 `201`）+ 下述 JSON；**无** `record`、**无** `audit_record`。更新后的待办行与审计行如需查看，分别用 `GET /api/query`（如 `?tag=todo:in_progress` 或对应态）与 `?tag=todo:transition`。

```json
{
  "success": true,
  "id": "<todo uuid>",
  "transition": { "from": "<TodoState>", "to": "<TodoState>" }
}
```

- `id`：被流转的待办行 UUID（与请求体 `id` 相同）。
- `transition.from` / `transition.to`：均为 **TodoState** 字面量（`in_progress` \| `completed` \| `cancelled` \| `paused`），与请求体 `target` 同一套词汇；**不是**完整 tag（勿写 `todo:completed`）。
- `from` = 事务开始前读到的代表状态；`to` = 请求的 `target`（且已校验 `to ≠ from`）。

---

## 4. 审计行（transition 插入的 text）

| 字段 | 值 |
|------|-----|
| `happened_at` | 请求体中的 `happened_at` |
| `value_number` | null |
| `value_text` | 见下表（**必须完整重复**待办当前 `value_text` 原文） |
| `objective_context` | `The index of the to-do is {todo.id}`（备查；很少用） |
| `subjective_interpretation` | null（或不传） |
| `tags` | `["todo:transition"]` |

### 4.1 `value_text` 模板（英文，与状态一致）

须带上该待办行落库的创建时间（列 `happened_at`，即创建请求里的 `created_at`），格式与库中存串一致（ISO 8601），不得改写。

| `target` | `value_text` |
|----------|----------------|
| `completed` | `Complete a to-do created at {todo.happened_at}: {todo.value_text}` |
| `cancelled` | `Cancel a to-do created at {todo.happened_at}: {todo.value_text}` |
| `paused` | `Pause a to-do created at {todo.happened_at}: {todo.value_text}` |
| `in_progress` | `Resume a to-do created at {todo.happened_at}: {todo.value_text}` |

其中 `{todo.happened_at}` / `{todo.value_text}` 为流转**之前**读到的待办行字段全文拼接，不得截断、不得改写。

### 4.2 通知范围（**已拍板**）

一次 transition **成功**后：`notify_user` **恰好一次**（除非 `suppress_notification: true` 则整次跳过）。

- 通知正文与本次 **INSERT 的审计行** `value_text` **字节级完全一致**（即 §4.1 模板拼出的那串英文）。
- **不**另就「更新后的待办行」再 notify 一次；双端（Next / Go）必须同一规则、同一文案。
- 通知失败不影响已提交事务（best-effort，与其它 log 一致）。

---

## 5. 查询（不新开 API）与响应字段别名

沿用 `GET /api/query`：

- **活跃清单（主路径）**：`?tag=todo:in_progress`（可加 `from` / `to` / `limit`）。
- 其它状态同样可查：`todo:completed`、`todo:cancelled`、`todo:paused`。
- 审计流水：`?tag=todo:transition`。
- 列表顺序：全局 query 契约（`happened_at ASC, id ASC`），本功能不特殊排序。

AI 工作流示意：query 活跃 → 读 `id` 与 `content` → transition。

### 5.1 列表项 JSON 变形（查询 `records[]`）

在 **序列化为 JSON 之前**（或序列化时按行分支），对每一行：

| 行判定 | JSON 行为 |
|--------|-----------|
| **待办行**（查询侧判定见 §1.3「略宽」规则） | 对外键名：`happened_at` → **`created_at`**，`value_text` → **`content`**；其余字段默认序列化不变。响应中**不再出现**该行的 `happened_at` / `value_text` 键（避免双键并存）。 |
| **审计行**（`todo:transition`）及其它非待办行 | **默认 toJSON**，仍为 `happened_at` / `value_text`（与现网 Record 契约一致），**不做**别名。 |

**对外变形范围（已拍板）**：凡 HTTP 响应里出现的**待办行**——含 `GET /api/query` 的 `records[]`、`POST /api/log/todo` 的 `201.record`——**都必须**使用 `created_at` / `content`，双端一致。审计行始终默认形状。**`POST /api/log/todo/transition` 成功响应不含 `record`**（见 §3.5），故无待办行变形问题。

### 5.2 实现备忘（Next / Go）

- **Next**：在 query 组装响应处按行 `isTodoRecord(tags)`，映射为 `{ ...rest, created_at, content }`（去掉原 happened_at / value_text 键），或小函数 `toQueryRecordJson(row)`。
- **Go（推荐）**：不要和普通 `record.Record` 抢同一套固定 `json` tag。查询响应改为 `[]any`（或 `[]json.Marshaler`）：
  1. 待办行 → 填入 `TodoRecordJSON`（字段 `CreatedAt`/`Content` 等带 `json:"created_at"` / `json:"content"`）；
  2. 其它行 → 仍用现有 Record 的默认 JSON；
  3. `json.Marshal` 包一层 `{ "records": [...] }`。  
  等价于「Record → TodoRecord → 放进 `[]any` 再编码」，类型安全优于手写 `map[string]any`；双端测试用共享 fixture 断言待办行键名与审计行键名。

库内列名与 SQL **不变**，别名仅出现在 HTTP JSON。

### 5.3 日后导入 / 导出（此处不实现，只记账）

将来做导入导出时：**同时接受变形与不变形的 JSON**，以简化工具与人工改文件的成本——例如待办行既可出现 `created_at`+`content`，也可出现库契约键 `happened_at`+`value_text`（导入侧归一到列）；导出可选一种主形状，但导入勿只认一种。  
**本阶段不实现导入导出**；仅记下「存在 JSON 字段变形」这一事实，避免日后误以为线上只有一种键名。

### 5.4 给 AI 操作手册的硬性说明（未写手册，此处预留）

日后撰写「AI 操作手册 / tool 说明」时，**必须写清楚**（勿让模型以为库字段就叫 created_at）：

1. **对 AI 可见的 HTTP JSON（待办行）**使用别名：`created_at`、`content`（创建请求也用这两键；**query** 与 **创建成功** `record` 同样）。transition 成功响应**没有**待办 `record`，只有 `id` + `transition.from`/`to`（TodoState 字面量）。
2. **数据库真实列名仍是** `happened_at`、`value_text`；变形只发生在 API 边界。
3. **流转**请求时间字段仍是 `happened_at`（审计时间），不要写成 `created_at`。
4. **审计行**若出现在 query 响应中仍是 `happened_at` / `value_text`，没有 content 别名。
5. 闭集五个 tag 见 §1.2；查询活跃清单用 `tag=todo:in_progress`。

本小节只作备忘，**不**在本阶段产出手册正文。

---

## 6. 与现有原则的关系

| 原则 | 本功能 |
|------|--------|
| AI append-only | **有意例外**：transition 允许 AI 更新待办行的**代表状态 tag**；正文与其它字段仍不改 |
| 保留 tag + 专用 API | 与 `transaction_entry`、`body:weight` 同模式 |
| 纠错 | 待办「完成/取消」走 transition + 审计，不靠改 `value_text`；改错正文仍靠 Admin PATCH 或新待办（正文 PATCH 策略不在本篇扩大） |
| 双端同构 | 日后实现必须 Next + Go + OpenAPI + 共享错误文案 fixture |

---

## 7. 实现时模块草案（开发阶段再用，此处仅备忘）

- OpenAPI：`LogTodoRequest`、`LogTodoTransitionRequest`、TodoState 枚举、`TodoRecord`（query / 创建成功 `record` 中的待办形状）、transition 成功体（`success` + `id` + `transition.{from,to}`，无 record）、路径挂到 `log.yaml`；query 响应说明 records 元素可能为 Record 或 TodoRecord。
- `RESERVED_TAG_PREFIXES` += `todo`；`reservedTagError` 按前缀指向 `/api/log/todo`。
- 纯逻辑包建议：`tododraft`（解析创建 / transition）+ `logapi.CreateTodo` / `TransitionTodo`（事务）+ query 层 `toQueryRecordJson` / Go `TodoRecordJSON`。
- 测试：四类 transition 错误全文双端断言；创建 tags 组装；事务失败回滚；保留 tag 拒绝对通用 log；**query 待办行 JSON 键为 created_at/content、审计行仍为 happened_at/value_text**。

---

## 8. 已拍板清单（讨论结论）

1. 初始状态 tag = `todo:in_progress`。  
2. 四态：`in_progress` / `completed` / `cancelled` / `paused`；任意互转；无边约束。  
3. 路径：`POST /api/log/todo`、`POST /api/log/todo/transition`。  
4. 创建允许额外非保留 tags；服务端前缀加入 `todo:in_progress`。  
5. transition **只**替换代表状态 tag，不动其它 tags / 字段。  
6. **创建** JSON：`created_at`（→ 库 `happened_at`）、`content`（→ 库 `value_text`）、`objective_context` 必填；`subjective_interpretation` / `suppress_notification` 可选。请求禁止再传 `happened_at` / `value_text` 键名。  
7. **流转** JSON：仍用 `happened_at`（审计时间），**不用** `created_at` / `content`。  
8. **Notify**：创建成功走 `notify_user`（可 suppress）。transition **成功恰好 notify 一次**（可 `suppress_notification`）；正文与插入审计行的 `value_text` **字节级一致**；**不**就待办行再 notify。双端必须一致。  
9. AI 与 Admin 均可调 transition。  
10. 审计必须重复待办原文，并带上待办创建时间（`created at {todo.happened_at}`）；`objective_context` 只备查 id。  
11. 禁止对审计行 transition；uuid 不存在 / 非待办 / 审计 / target 相同 → **四类不同英文报错**。  
12. **对外待办行变形**：仅 **query** 的 `records[]` 与 **创建** 成功 `201.record` 使用 `created_at`+`content`；审计行默认 toJSON。**transition 成功响应无 `record`**（见第 17 条）。Go 用 `TodoRecordJSON` + `[]any`（或等价 Marshaler）。  
13. **五 tag 闭集**定死；录入严、查询略宽，**Node/Go 宽松度必须一致**（共享判定 + fixture）。  
14. **AI 手册预留（§5.4）**：必须向 AI 说明「对外别名 vs 库列 happened_at/value_text」；本阶段不写手册。  
15. **导入/导出**（未做）：日后同时接受变形与不变形 JSON（§5.3）；本阶段只记账。  
16. **本阶段只产出本文档，不开发。**  
17. **transition 成功响应（已拍板）**：HTTP **`200`** + `{ success, id, transition: { from, to } }`；`from`/`to` 为 TodoState 字面量（与请求 `target` 同词汇，非 `todo:*` tag）；**无** `record`、**无** `audit_record`。

---

## 9. 开放小项（不阻塞定稿；已收两项保留备查）

- **【已收】** transition 成功 HTTP：**`200`**；JSON 为 `{ success, id, transition: { from, to } }`（`from`/`to` = TodoState 字面量）；**无** `record` / **无** `audit_record`。详见 §3.5、§8 第 17 条。  
- **【已收】** transition notify：成功时**恰好一次**（除非 `suppress_notification`）；正文 = 审计行 `value_text`（字节一致）；不另通知待办行。详见 §4.2、§8 第 8 条。  
- Admin PATCH 是否允许改待办正文（库列 `value_text`；与保留 tag 的 PATCH 规则需对照现有 admin 行为）。  
- OpenAPI 对 `records[]` oneOf 写到多严（严格 schema vs description-only）。  
- **导入/导出**（未排期）：详见 §5.3。  
- **AI 操作手册**（未排期）：按 §5.4 条目展开。

---

## 10. 实现分期

前端仍 **pass/skip**（本篇非目标）。每期凡动 API：**OpenAPI + fixtures + Next + Go + 双端测试**（见 `AGENTS.md`）；可增量扩大表面。契约口径不变（§8），分期只切交付边界。

**依赖总览**：1 → 2 →（3 ∥ 4）。Phase 3 与 4 互不依赖，可并行。

### Phase 1 — 保留前缀 `todo`（小）✅ 已完成（2026-08-03）

| | |
|--|--|
| **目标** | 录入侧严禁伪造 `todo` / `todo:*`，与 `transaction_entry` / `body:weight` 同模式。 |
| **范围内** | `RESERVED_TAG_PREFIXES` += `todo`；`reservedTagError` 指向 `/api/log/todo`；通用 `log/number`·`text`·`transaction`·`body/weight` 与 Admin rename from/to 拒写/拒改名；双端 + 契约测。 |
| **范围外** | 任何新路由；`tododraft` / create / transition / query 变形。 |
| **交付** | tags 改动；拒写 fixture；OpenAPI 若有保留前缀列举则同步（无新 path）。 |
| **依赖** | 无。 |
| **验证** | `npm test` / `go test` 中 reserved 用例覆盖 `todo`、`todo:in_progress` 等；现有体重/交易拒写仍绿。 |
| **落地** | Next `src/lib/tags.ts` + Go `faas/internal/tags`；错误文案 `use POST /api/log/todo for to-do entries`；OpenAPI 保留前缀列举已含 `todo`。 |

> 期内 `/api/log/todo` 尚不存在；错误文案可先指向该 path（与体重先例一致，短空窗可接受）。

### Phase 2 — 创建 `POST /api/log/todo`（中）✅ 已完成（2026-08-03）

| | |
|--|--|
| **目标** | AI/Admin 可创建待办；落库 `todo:in_progress`；创建成功 notify；`201.record` 已按待办行变形。 |
| **范围内** | OpenAPI：`LogTodoRequest`、TodoState（可先挂枚举）、`TodoRecord`、path；`tododraft` + `logapi.CreateTodo` / `createTodo`；Next/Go handler；tags 组装（状态 tag 在前）；`notify_user` + `suppress_notification`；共享变形 helper（供 `201.record`，Phase 4 复用）；录入侧严判定辅助可先落地。 |
| **范围外** | transition；**query** `records[]` 变形（期内 query 待办行仍可能是 `happened_at`/`value_text`，已知短暂不一致）；审计行。 |
| **交付** | 新 path + 双端实现 + 创建/校验/notify/变形 fixture；分层对照表补 `tododraft` / `CreateTodo`（实现时改 `docs/20260801-api-layering.md`）。 |
| **依赖** | Phase 1。 |
| **验证** | `openapi:lint` + `test:openapi` + `faas` contract；创建 201 键为 `created_at`/`content`；缺字段/保留 tag/未知键 400；suppress 跳过 notify。 |
| **落地** | Next `src/lib/tododraft.ts` + `logapi.createTodo` + `src/app/api/log/todo`；Go `faas/internal/tododraft` + `logapi.CreateTodo` + `httpx`；OpenAPI `LogTodoRequest` / `TodoRecord` / `TodoRecordSuccess` / `TodoState`；变形 fixture `testdata/todo-record-deform.json`。 |

### Phase 3 — Transition + 审计 + notify（大）✅ 已完成（2026-08-03）

| | |
|--|--|
| **目标** | 四态任意互转；同事务 UPDATE tags + INSERT 审计；`200` 成功体；恰好一次 notify。 |
| **范围内** | OpenAPI：`LogTodoTransitionRequest`、成功体（`success`+`id`+`transition.{from,to}`）；`TransitionTodo` 事务；§3.3 四类英文错误 + `target` 非法文案；§4.1 审计 `value_text` 模板；§4.2 notify 正文 = 审计文案；录入侧严「待办行」判定。 |
| **范围外** | query 变形；改待办正文/额外 tags；状态机边约束；前端。 |
| **交付** | path + 双端事务实现 + 错误/审计/notify/成功体 fixture（Node/Go 字节一致）。 |
| **依赖** | Phase 2（待办行与 tag 闭集已存在）。**不依赖** Phase 4。 |
| **验证** | 四类错误全文双端断言；`target === current` 拒绝；事务失败回滚（无半更新/半审计）；成功无 `record`/`audit_record`；notify 一次且正文一致；`suppress_notification`。 |
| **落地** | Next `tododraft.parseTodoTransition` + `logapi.transitionTodo` + `src/app/api/log/todo/transition`；Go `tododraft.ParseTodoTransition` + `logapi.TransitionTodo` + `httpx`；OpenAPI `LogTodoTransitionRequest` / `TodoTransitionSuccess`；审计模板 fixture `testdata/todo-transition-audit.json`。 |

### Phase 4 — Query 待办行 JSON 变形（中）

| | |
|--|--|
| **目标** | `GET /api/query` 的待办行与创建成功形状对齐（`created_at`/`content`）；审计行保持默认 Record JSON。 |
| **范围内** | 查询侧**略宽**判定（§1.3）+ 共享 fixture（含脏数据边：四态+transition 并存等）；Next `toQueryRecordJson` / Go `TodoRecordJSON`+`[]any`；OpenAPI 对 `records[]` 说明（oneOf 严度按 §9 小项，可先 description）。 |
| **范围外** | 新 query API；导入/导出（§5.3）；AI 手册（§5.4）。 |
| **交付** | query 序列化分支 + 双端同 fixture；复用 Phase 2 变形 helper。 |
| **依赖** | Phase 2。**不依赖** Phase 3（可与 3 并行）；有 transition 数据时加审计行对照测更稳。 |
| **验证** | `?tag=todo:in_progress` 等：待办行无 `happened_at`/`value_text` 键；`?tag=todo:transition` 仍为库契约键；Node/Go 宽松度一致。 |

### 刻意不分期 / 不排入上表

- 前端清单 UI、due/优先级等（§0 非目标）。
- Admin PATCH 改待办正文、导入导出、AI 手册（§9 开放项）。
- 勿把「仅 OpenAPI 无实现」或「只改一端」拆成独立期。
