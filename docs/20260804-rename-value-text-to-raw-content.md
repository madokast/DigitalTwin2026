# DigitalTwin2026：`value_text` 全量重命名为 `raw_content`（可行性分析与实施计划）

> 创建日期：2026-08-04
> 状态：**已落地**（2026-08-04：commit A `e197f8c` 审计/通知行为变更 + commit B 全仓机械改名与契约/文档同步；决策 D1–D11 全部定案，见 §7）
> 前提（2026-08-04 确认）：**无历史数据、项目未上生产、数据库直接重写不做迁移**
> 性质：Diataxis **explanation** + **how-to** 混合；锁定表见 §7
> 相关：[`AGENTS.md`](../AGENTS.md)（JSON snake_case / 双后端 / DB 纪律）、[`README.md`](../README.md)（数据模型）、[`docs/20260802-todo-feature.md`](20260802-todo-feature.md)（`content` 别名与审计 `value_text`）、[`docs/20260803-records-import-export.md`](20260803-records-import-export.md)（JSONL 键）、[`docs/20260803-utc-offset.md`](20260803-utc-offset.md)（§11 DB 改基准流程）、[`docs/20260801-api-layering.md`](20260801-api-layering.md)（双端模块对齐表）

## 0. 一句话结论

**可行，且成本低**：全仓实测约 **515 处、80 个文件**命中 `value_text` / `valueText` / `ValueText`（`value_number` 家族另约 **543 处、85 个文件**，D8 一并改名），除 DB 列名、SQL、Go/TS 标识符、JSON/JSONL 键外无逻辑差异，本质是**纯机械的符号重命名**（`TEXT` 类型、`*string` 可空语义、约束结构全部不变）。另含**两项已定案的行为变更**：审计行 `raw_content` 改为逐字拷贝原待办正文、合成句迁入 `objective_context`（§3.1，彻底消除"合成文案冒充原文"的语义矛盾）；通知正文改为新一句话模板（D6）。必须正视的点：**对外契约破坏性变更**（§3.2）。按 §5 分阶段执行、双端同窗口上线即可收敛。

## 1. 目标与命名映射

把 `value_text` 及其一切大小写 / 驼峰 / 蛇形变体统一改名为 `raw_content`（同理变体）：

| 现状 | 改后 | 出现域 |
|------|------|--------|
| `value_text`（snake_case） | `raw_content` | DB 列名、SQL、HTTP JSON 键、JSONL 键、错误文案、OpenAPI、fixtures、testdata |
| `valueText`（camelCase，TS） | `rawContent` | `src/lib`、`src/app`、`src/components`、测试 |
| `ValueText`（PascalCase，Go） | `RawContent` | `faas/internal/**`、Go 测试 |
| `value_number`（snake_case） | `numeric_value`（D8 已定案 B） | DB 列名、SQL、HTTP JSON 键、JSONL 键、错误文案、OpenAPI、fixtures、testdata |
| `valueNumber`（camelCase，TS） | `numericValue` | 同上 |
| `ValueNumber`（PascalCase，Go） | `NumericValue` | 同上 |

检索口径：`rg -i "value_text|valuetext"` + `rg -i "value_number|valuenumber"`（大小写不敏感已覆盖 camelCase / PascalCase；无连写变体）。全部命中按 §3.1 的语义核查后逐层替换；`content` / `created_at` 别名键**不在**范围（见 §3.3、§3.4）。`chk_value` 约束名**在**范围：改名 `chk_raw_content`（D5 已定案 B）。

## 2. 影响面清点（2026-08-04 实测）

### 2.1 代码 / 契约 / 数据层（`value_text` 家族约 371 处 / 69 文件 + `value_number` 家族约 543 处 / 85 文件；下表面按 value_text 口径）

| 层 | 命中行数 / 文件数 | 代表性位置 |
|----|-------------------|-----------|
| DB 基准（Drizzle） | 5 / 2 | `src/db/schema.ts:10,16`（`valueText: text('value_text')`、`check('chk_value', ...)`）；`drizzle/0000_many_invaders.sql:6,10`（列名 + 约束名 `chk_value` → `chk_raw_content`）；`drizzle/meta/0000_snapshot.json:35,36,68` |
| Next（TS） | 139 / 27 | `src/lib/record.ts`（类型 `Record` / `RecordRow` / `fromDB` / `update`）、`src/lib/draft.ts`（请求键 `value_text`、`Invalid value_text`、双 null 文案）、`src/lib/logapi.ts`、`src/lib/tododraft.ts`（`auditValueText`→`todoAuditNotifyText`）、`src/lib/recordjsonl.ts`、`src/lib/importapi.ts`、`src/lib/exportapi.ts`、`src/lib/query.ts`、`src/lib/telegram.ts`（`value_number: ` / `value_text: ` 标签）、`src/lib/api-client.ts:99`、`src/components/records-table.tsx:52`、`src/app/records/[id]/page.tsx`（编辑草稿 `n` → `value_text`） |
| Go FaaS | 131 / 26 | `faas/internal/record/record.go`（struct `ValueText` `json:"value_text"`、SQL、`FromDB`）、`draft/draft.go`、`tododraft/tododraft.go`（`NormalizedTodo.ValueText`、`AuditValueText`）、`logapi/log.go` + `todo.go`（SQL、`Missing required field: value_text`、`auditValueText` 字段）、`query/query.go:164,244`（`q` LIKE 列）、`recordjsonl/recordjsonl.go`（键列表、`Invalid value_text`、双 null 文案）、`importapi/importapi.go:221`、`exportapi/exportapi.go:71,125`、`telegram/telegram.go:82-89,187-188`（通知标签 `value_number: ` / `value_text: `）、`httpx/server.go`、`contract/contract_test.go` |
| OpenAPI + fixtures | 30 / 9 | `openapi/components/schemas.yaml`（`Record` 必填/字段、todo 变形说明、审计行描述）、`openapi/paths/log.yaml`、`admin.yaml`、`query.yaml`；`openapi/fixtures/*.json`（4 个） |
| 测试 + testdata | 66 / 5 | `tests/api/routes.test.ts`（37 处）、`tests/openapi/contract.test.ts`（2 处，含驼峰拒绝用例）、`testdata/record-jsonl-cases.json`（27 处）、`todo-record-deform.json`、`todo-transition-audit.json` |

### 2.2 文档层（约 96 处、12 个文件）

| 文件 | 命中 | 性质 |
|------|------|------|
| `docs/20260802-todo-feature.md` | 30 | **living 规格**：别名表（`content` ↔ `value_text`）、§4.1 审计 `value_text` 模板、禁键说明——须改 |
| `docs/20260728-fuzzy-time.md` | 35 | 历史文档（搜索行为描述）——建议不改（§3.5） |
| `docs/20260729-schema-v1.md` | 10 | 历史 schema 记录——建议不改 |
| `docs/20260801-development-log.md` | 7 | 历史日志——不改 |
| `docs/20260730-development-log.md` | 3 | 历史日志——不改 |
| `docs/20260801-api-layering.md` | 2 | **living**：双端模块表含 `AuditValueText` / `auditValueText`——须改 |
| `docs/20260731-development-log.md` | 2 | 历史日志——不改 |
| `docs/20260803-records-import-export.md` | 1 | **living**：JSONL 字段表——须改 |
| `docs/20260727-initial-vision.md` | 1 | 历史愿景——不改 |
| `README.md` | 3 | **living**：数据模型表 + 待办行变形说明——须改 |
| `AGENTS.md` | 1 | **living**：§JSON 键名示例——须改 |

### 2.3 不受影响的域（已确认 0 命中）

`faas/providers/*`、`scripts/`、`.github/`、`.env*`、`docs/20260803-utc-offset.md`、`src/lib/transactiondraft.ts`。

## 3. 语义核查（关键风险）

### 3.1 ✅ 审计行设计变更（2026-08-04 定案）：`raw_content` 不再存合成文案

`records` 是**单一表**：普通文本行、数值附注行、todo 行、todo **审计行**共用 `value_text`（→`raw_content`）列。**旧设计**（20260802-todo-feature §4.1）下审计行的 `value_text` 存服务端合成的英文句：

```
"Complete a to-do created at 2026-08-02T02:00:00.000Z: Buy milk"
```

**新设计（已定案，无历史数据、未上生产，直接生效无需迁移存量）**——审计行改为「原文快照 + 客观上下文句」：

| 字段 | 新值 |
|------|------|
| `raw_content` | **逐字拷贝**流转前待办行的 `raw_content` 原文（如待办「回家前取快递」，审计行同为「回家前取快递」），不得拼接、不得改写 |
| `objective_context` | 合成句 `{Verb} a to-do {todo.id} created at {todo.happened_at}`（四动词：`Complete` / `Cancel` / `Pause` / `Resume`；`{todo.happened_at}` 为 `fromDB` 已按 `utc_offset` 格式化的带区串，零成本）——取代旧值 `The index of the to-do is {todo.id}` |
| `ai_analysis` | null（不变） |

**信息保全性 ✓**：动词 + uuid + 待办创建时间全在 `objective_context`，正文在 `raw_content`，无信息丢失；uuid 可溯源到原待办行。

**函数变化**：存储不再需要合成器——`raw_content` 直接拷贝；`AuditObjectiveContext` / `auditObjectiveContext` 签名由 `(todoID)` 扩为 `(target, todoID, happenedAt)` 合成客观上下文句。**通知合成器改名改模板**：原 `AuditValueText` / `auditValueText` **改名为 `TodoAuditNotifyText` / `todoAuditNotifyText`**（通知专用，模板见下），`TransitionResult.AuditValueText` / `TransitionTodoOk.auditValueText` 内部通知字段同步改名为 `TodoAuditNotifyText` / `todoAuditNotifyText`（仅 notify 使用，不出现在 HTTP 响应——成功响应固定为 `{success, id, transition}`，见 20260802-todo-feature §3.5）。

**通知正文（D6 已定案）**：transition 成功后的 `notify_user` 正文 = 一句话：

```
{Verb} a to-do {todo.id} created at {todo.happened_at}: {raw_content}
```

即 **审计行 `objective_context` + `": "` + 审计行 `raw_content`**（`{raw_content}` 为待办正文逐字拷贝，与审计行 `raw_content` 同值）。与存储不再字节级一致（旧 §4.2 不变式更新为「通知可由审计行 `objective_context` 与 `raw_content` 两字段还原」），uuid 可溯源、正文可读。

**⚠️ 通知正文缺口（D6 已定案，见 §3.1 通知正文段与 §7）**：旧规格 §4.2 锁定「通知正文与审计行 `value_text` **字节级一致**」，现状 `notify_user` 发的就是合成句（`route.ts:20` / `server.go:319-321`）。新模板为 `{Verb} a to-do {uuid} created at {time}: {raw_content}`（= `objective_context` + `": "` + `raw_content`，可还原但非字节一致）。

**副作用（接受）**：审计行在 `GET /api/query` 结果中与待办行正文相同，靠 `tags = ["todo:transition"]` 与 `objective_context` 内的 uuid 区分；动词不再是正文的一部分。审计行仍无四态 tag，不触发 todo 行变形。

### 3.2 ⚠️ 对外契约是破坏性变更（breaking）

`value_text` 出现在**请求键、响应键、JSONL 键**三处对外表面：

- 请求：`POST /api/log`（`src/lib/draft.ts:9` 键列表）、`PUT /api/records/[id]`（`src/app/records/[id]/page.tsx` 编辑体）——改后 `raw_content`（`value_number` 同批改为 `numeric_value`）；旧客户端带 `value_text` → **unknown key 400**（严格模式，双端一致）。
- 响应：`Record.value_text` → `raw_content`（`src/lib/record.ts:14`、Go `record.go:22`、OpenAPI `Record`）。
- JSONL：import/export 键 `value_text` → `raw_content`；**旧导出文件将无法导入**（未知键 400 + 双 null 文案变化）。
- 错误文案字节变化（Node/Go 必须同步）：`Invalid value_text` → `Invalid raw_content`；`value_number and value_text cannot both be null` → `numeric_value and raw_content cannot both be null`；`Missing required field: value_text` → `...: raw_content`；telegram 通知标签 `value_text: ` → `raw_content: `、`value_number: ` → `numeric_value: `（用户可见英文）。

可接受性：本项目为单用户自用（网页 + 机器人），无外部集成方；且**无历史数据**（无旧导出文件、无旧客户端存量），旧键兼容毫无意义。**推荐纯 breaking、一次到位**，不做新旧双键并存（与 strict unknown-key 模式及 AGENTS「单一契约」纪律冲突）。**已锁定：D2 = A**。

### 3.3 别名关系不变

todo 待办行的对外别名 `content` / `created_at` **保持不动**，仅底层映射更新为 `content` ↔ DB `raw_content`（原 `content` ↔ `value_text`）。todo 请求键 `content` 本身不含 `value_text`，无替换。

### 3.4 明确不动项

- `happened_at`、`utc_offset`、`tags`、`objective_context`、`ai_analysis`。
- 驼峰拒绝行为：`valueText` / `valueNumber` 作为请求键仍 → 400（`tests/openapi/contract.test.ts:245` 用例**保留不变**，其语义是「驼峰键非法」）。
- 无索引、无外键涉及这两列（`0000` 建表 SQL 仅 3 条 CHECK），改名无索引副作用。

> **例外**：`chk_value` 约束名**属于变更项**（D5 已定案 B → `chk_raw_content`），随列名一起改；`0000` 建表 SQL 的约束名与 `schema.ts` 的 `check('chk_value', ...)` 第一参数同步改，表达式中的列引用随列名变化。`value_number` 家族同为变更项（D8 → `numeric_value`），见 §1。

### 3.5 历史文档不改写

dev logs、`20260727-initial-vision.md`、`20260729-schema-v1.md`、`20260728-fuzzy-time.md` 是**当时决策的记录**，改写会伪造历史；只更新 living 文档（§2.2 表「须改」行 + 本文），并在历史文档**顶部加一行 pointer 指向本文**（D4 已定案 C）。

### 3.6 已知坑与规避（执行时逐条对照）

| # | 坑 | 规避 |
|---|-----|------|
| 1 | **测试断言不能盲替**：`not.toHaveProperty`（响应断言）、`toContain`（错误文案断言）、todo **禁键**断言（todo 请求带 `value_text` → 400）三类语义不同 | 逐条人肉过：响应断言 → 新键；文案断言 → 新文案；todo 禁键断言 → 禁 `raw_content` / `numeric_value`（todo 仍不接受这两键）；驼峰拒绝用例（`valueText` / `valueNumber` → 400，`contract.test.ts:245`）**保留不变** |
| 2 | **snapshot 约束表达式带表名**：`"records"."value_text"` 三处替换（列名、约束名、表达式）引号 / 表名前缀各异 | 用 `rg -n "value_text" drizzle/` 逐条核对 |
| 3 | **`todo-transition-audit.json` 4 行 uuid 一一对应**：objective_context 句里的 uuid 是各自待办 id | 重写 fixture 时逐行比对，勿抄错 |
| 4 | **Go `insertReturning` 参数顺序**（`nil, &vt` = 数值列 / 文本列） | 改名后盯参数位置，`NumericValue` / `RawContent` 互换会静默写错列 |
| 5 | **commit A 通知 / 客观上下文句的时间**：必须用 `fromDB` 后的带区串（`todoRec.happened_at` / `todoRec.HappenedAt`），**不得**用 `time.Time` 原始值（双端一致） | 实现时直接读 Record 字段 |
| 6 | **JSONL 键清单与 create 请求键清单是两份独立列表**（`recordjsonl.ts` vs `draft.ts`，Go 侧同理） | 对照改、互相校验，逐项比对新键集合 |
| 7 | **`chk` 约束错误无测试依赖**（已核：无断言 PG 约束名）——改名安全 | 无需处理 |
| 8 | **`openapi/redoc-static.html` 不入库**（仅 `redocly.yaml` 跟踪）——无需重新生成 | 无需处理 |
| 9 | **`transactiondraft.ts` 不含 `value_number`**（已核）——batch 记录不涉及 | 无需处理 |

## 4. 可行性结论

| 维度 | 评估 |
|------|------|
| 技术可行性 | **高**。纯符号替换，无类型 / 结构 / 约束 / 索引变化；`valueText: text('value_text')` → `valueText: text('raw_content')` 一行即可。 |
| 主要成本 | 契约破坏（§3.2）需双端 + OpenAPI + fixtures + 测试**同一提交**原子完成，CI 门闸（`openapi:lint`、contract、双端集成）全量回归。 |
| 数据成本 | **零**：无历史数据、未上生产，直接 drop `records` 后按基准重建，无迁移、无回填、无 `RENAME COLUMN`（已锁定，§5.1）。 |
| 遗漏风险 | 低：以 `rg -i "value_text|valuetext"` 归零为准（§5.7），注释与文档一并覆盖。 |
| 总体 | **推荐执行**；commit A（行为）→ commit B（改名）顺序落地，双后端同 PR 或连续 PR 同窗口部署。 |

## 5. 实施计划（分阶段）

> 原则：**行为先行、改名随后（commit A + commit B，见 §5.0）；契约同步、文档收尾**；每个 commit 自洽且门闸全绿，任意阶段可回滚。

### 5.0 提交拆分（D11 已确认 B）

| commit | 内容 | 自洽性 |
|--------|------|--------|
| **A（行为先行）** | 审计行改为原文快照 + `objective_context` 合成句（D1）；通知新模板（D6，措辞 D7）；**直接用终态符号名** `TodoAuditNotifyText` / `todoAuditNotifyText`、`AuditObjectiveContext` / `auditObjectiveContext` 扩签名；相关测试与 `testdata/todo-transition-audit.json` 值更新（键名仍旧 `value_text` / `value_number`） | 行为全绿；rename sweep 中不再出现审计符号，保持纯机械 |
| **B（机械改名）** | `value_text`→`raw_content` + `value_number`→`numeric_value`（D8）全仓替换；`chk_value`→`chk_raw_content`（D5，**必须随列改名**）；错误文案、JSONL 键（D2）、OpenAPI + fixtures、README/AGENTS、living docs（D4 的 pointer） | 纯机械 + 契约同步，门闸全绿 |

> `chk_raw_content` 不能提前到 commit A：名字引用的列此刻还是 `value_text`，中间态名实不符。

### 阶段 1 — DB 基准（commit B；先改，供阶段 5 重建测试库）

1. `src/db/schema.ts`：`:10` `valueText: text('raw_content')`；**`:9` `valueNumber: text('numeric_value')`（D8）**；`:15-16` 注释与 `check('chk_value', ...)` 同步（D5 → `chk_raw_content`）。
2. `drizzle/0000_many_invaders.sql`：列名 `value_text` → `raw_content`、`value_number` → `numeric_value`；约束名 `chk_value` → `chk_raw_content`，表达式同步。
3. `drizzle/meta/0000_snapshot.json`：`value_text` 键名（`:35,36`）、`value_number` 键名、`chk_value` 约束名 / 表达式（`:68`，**表达式带表名前缀 `"records"."..."`，三处替换各有引号 / 表名，易漏——坑 #3**）同步（仓库流程：改基准定义后按基准重建，**不**加增量 migration——见 `docs/20260803-utc-offset.md` §11）。
4. **DB 重建（已锁定）**：本地 / 测试库 DROP `records` 后按新基准重建；无历史数据、未上生产，不需要任何迁移 / 回填 / `RENAME COLUMN`（决策点 D3 = A）。

### 阶段 2 — Next 代码（`src/`；commit B 机械部分）

机械替换 `valueText` → `rawContent`（标识符）与 `value_text` → `raw_content`（JSON 键、错误文案、SQL/列引用），逐文件过一遍：

`src/lib/record.ts`、`draft.ts`、`logapi.ts`、`tododraft.ts`、`recordjsonl.ts`、`importapi.ts`、`exportapi.ts`、`query.ts`、`telegram.ts`、`api-client.ts`、`src/components/records-table.tsx`、`src/app/api/log/**`、`src/app/api/export/records/route.ts`、`src/app/records/[id]/page.tsx`。注意 `src/lib/recordjsonl.ts` 的键列表 / 错误文案与 Go 字节一致（§3.2 列表）。

### 阶段 3 — Go FaaS（`faas/`；审计行为部分已在 commit A 落地，见 §5.0）

`ValueText` → `RawContent`（struct 字段、函数参数、局部变量），SQL 字符串中列名 `value_text` → `raw_content`，错误文案按 §3.2 列表同步。模块清单见 §2.1 表（`record`、`draft`、`tododraft`、`logapi`、`query`、`recordjsonl`、`importapi`、`exportapi`、`telegram`、`httpx`、`contract`）。

### 阶段 4 — OpenAPI + fixtures

`openapi/components/schemas.yaml`（`Record.required`、`Record.properties.value_text`、todo 变形说明两处、审计行描述、`PatchRecord` 说明）、`openapi/paths/{log,admin,query}.yaml` 全部引用、`openapi/fixtures/*.json` 4 个文件的键。**契约先行原则**：OpenAPI 是测试依据，先于阶段 5 完成。**审计行描述（行为部分）属 commit A**（§4.1 模板改为原文快照 + `objective_context` 句），键名替换归 commit B。

### 阶段 5 — 测试 + testdata

- `tests/api/routes.test.ts`（37 处：请求体、断言、错误文案）、`tests/openapi/contract.test.ts`（`value_text: null` 合法补丁键；`:245` 驼峰拒绝用例**不动**）。
- 各 `src/lib/*.test.ts`、Go 各 `*_test.go`。
- `testdata/record-jsonl-cases.json`（27 处 JSONL 行 + 双 null 错误文案）、`todo-record-deform.json`、`todo-transition-audit.json`。
- 审计相关断言（§3.1 行为变更，**commit A**）：`raw_content`（当时键名仍 `value_text`）= 待办正文逐字拷贝；`objective_context` = 新合成句（含 uuid 与带区时间）；`ai_analysis` = null；`testdata/todo-transition-audit.json` 4 行**值**重写；`todo.go:74,197` / `logapi.ts:253,345` 通知字段改名 **`TodoAuditNotifyText` / `todoAuditNotifyText`**（D6 模板，含 `": "` + 正文断言）。键名替换归 commit B。

### 阶段 6 — 文档（living 仅；行为部分随 commit A，机械改名部分随 commit B）

`README.md`（数据模型表 `value_text` 行、待办行变形说明两处）、`AGENTS.md`（§JSON 键名示例 `value_text` → `raw_content`）、`docs/20260802-todo-feature.md`（别名表、**§4 全节重写**：审计行改为原文快照 + `objective_context` 合成句、§4.2 通知模板按 D6 = `objective_context` + `": "` + `raw_content`）、`docs/20260801-api-layering.md`（2 处）、`docs/20260803-records-import-export.md`（字段表）。历史文档按 D4-C：正文不动，**顶部加 pointer 指向本文**（随 commit B）。

### 阶段 7 — 验证门闸（全部须绿）

1. `rg -i "value_text|valuetext"` → 仅剩：历史文档（白名单）+ 本文件的分析引用。
2. `npm run lint`、`npm run openapi:lint`。
3. `npm run test:unit`（含契约测试）。
4. `npm run test:integration`（双端；自动按新基准重建测试库）。
5. `cd faas && go test`（集成测加载根 `.env.test`；`-short` 纯单元）。
6. `npm run db:check`（新基准连通）。

### 阶段 8 — 部署（同窗口，避免契约分叉）

`npm run deploy -- prod`：Vercel（海外主站）与所选国内 FaaS（FC / SCF）**同时**发布；测试环境先走 `deploy test` 全链路验证（含机器人通知文案 `raw_content: `）。发布后旧客户端请求若仍带 `value_text` 会 400，属预期（§3.2）。

## 6. 验证勾选清单

- [ ] `0000_many_invaders.sql` / `0000_snapshot.json` / `schema.ts` 三处一致（列名 `raw_content` + `numeric_value`、约束名 `chk_raw_content`、表达式）
- [ ] 测试断言逐条过语义（§3.6 坑 #1：响应断言 / 文案断言 / todo 禁键 / 驼峰拒绝四类）
- [ ] Next 与 Go 的错误文案字节一致（3 条 + 通知标签）
- [ ] OpenAPI、fixtures、contract 测试三方一致
- [ ] JSONL import/export round-trip（新键）通过；旧键文件返回「未知键」类 400
- [ ] todo 行为仍输出 `content` / `created_at`（别名不变）；审计行 `raw_content` = 待办原文逐字拷贝、`objective_context` = 合成句（§3.1）
- [ ] 通知正文 = `{Verb} a to-do {uuid} created at {time}: {raw_content}`，双端字节一致（D6）
- [ ] `rg -i "value_text|valuetext"` 归零（白名单除外）
- [ ] 三端（Vercel + FC + SCF）同版本上线

## 7. 决策点汇总（全部已定案）

| # | 问题 | 选项 | 推荐 | 状态 |
|---|------|------|------|------|
| D1 | 审计行 `raw_content` 语义 | A. 存合成句（旧设计）；B. **存原文快照**，合成句迁 `objective_context` | **B**：`raw_content` 对所有行都是真"原文"，语义矛盾消除 | **已定案 B**（§3.1；原命名问题随之消失，`AuditValueText` 合成器整体删除） |
| D2 | JSONL / 请求键兼容策略 | A. 纯 breaking（旧键 → 400）；B. 导入端兼容旧键 | **A**：单用户 + strict 模式，双键并存违反契约纪律 | **已锁定 A**（无历史数据，无旧导出文件 / 旧客户端存量） |
| D3 | 库列改名方式 | A. drop `records` 按新基准重建；B. `ALTER TABLE ... RENAME COLUMN` 保留数据 | **A**：无历史数据、未上生产，直接重写最干净 | **已锁定 A**（零迁移成本；B 路径作废） |
| D4 | 历史文档 | A. 全改；B. 只改 living，历史记录留原文；C. **B + 历史文档顶部加一行 pointer 指向本文** | **C**：不伪造历史，同时保证可发现性 | **已定案 C** |
| D5 | `chk_value` 约束名 | A. 保留；B. 改名 `chk_raw_content` | **B**：列已更名，约束名随之对齐，消除名实不符 | **已定案 B** |
| D6 | **通知正文模板**（transition 成功后的 `notify_user`；旧 §4.2「与审计行 `value_text` 字节一致」不再成立） | A. 通知 = 审计行 `objective_context` 句（无正文）；B. 通知 = `{Verb} a to-do {uuid} created at {time}: {raw_content}`（含 uuid 与正文；= `objective_context` + `": "` + `raw_content`，可由审计行还原）；C. 通知 = `{Verb} a to-do: {content}` 简单句 | **B**：uuid 可溯源 + 正文可读，且仍与审计行保持可还原关系 | **已定案 B**（§3.1 通知正文段） |
| D7 | 新合成句英文措辞 | A. `a to-do`（连字符，沿用现有代码/文档口径）；B. `a todo`（用户示例写法） | **A**：与全部既有字符串一致 | **已锁定 A** |
| D8 | `value_number` / `valueNumber` / `ValueNumber` 是否顺带改名 | A. 不动；B. **改名 `numeric_value` / `numericValue` / `NumericValue`**（`value_` 前缀不复存在，非 raw 语义不再需要前缀） | **B**：与 `raw_content` 形成干净两族；弃用 `number`（规避保留字疑虑），`numeric_value` 语义明确、无歧义 | **已定案 B**（并入 commit B，D11） |
| D9 | todo 行 `content` 别名 | A. 保持（`content ↔ raw_content` 映射）；B. 顺带改 `raw_content` | **A**：todo API 零破坏 | **已确认 A** |
| D10 | telegram 通知标签 | `value_text: ` → `raw_content: `（A）；`value_number: ` → `numeric_value: `（A）；B. 用 `content: ` 等 | **A**：与全仓改名口径一致 | **已确认 A** |
| D11 | 提交粒度 | A. 单次大提交；B. **两次提交：commit A 行为先行（审计/通知，终态符号名）+ commit B 机械改名 + chk + 契约文档**；C. 多次拆分 | **B**：行为与命名正交，A 可独立审查且使 B 保持纯机械；chk 约束名依赖列改名（`chk_raw_content` 引用尚不存在的列），**不能**先提交，必须并入 B | **已确认 B** |

> 附注：`AuditValueText` / `auditValueText` → `TodoAuditNotifyText` / `todoAuditNotifyText`（通知合成器改名 + 改模板，§3.1、§8）。

## 8. 执行定位速查（关键锚点）

- DB：`src/db/schema.ts:10,16` · `drizzle/0000_many_invaders.sql:6,10` · `drizzle/meta/0000_snapshot.json:35,36,68`
- 对外键：`src/lib/record.ts:14`（Record 类型）· `src/lib/draft.ts:9,31,164-172`（请求键 + 文案）· Go `record/record.go:22`、`draft/draft.go:34`
- 审计（§3.1 行为变更）：`src/lib/tododraft.ts:204` + `faas/internal/tododraft/tododraft.go:209`（`auditValueText` / `AuditValueText` → **`todoAuditNotifyText` / `TodoAuditNotifyText`**）、`src/lib/logapi.ts:253,345` + `faas/internal/logapi/todo.go:74,197`（通知字段同步改名）、`logapi.ts:310-334` / `todo.go:145-184`（审计 INSERT）
- JSONL：`src/lib/recordjsonl.ts`、`faas/internal/recordjsonl/recordjsonl.go:29,118-128,235`
- 搜索：`faas/internal/query/query.go:164,244`、`src/lib/query.ts`
- 通知：`faas/internal/telegram/telegram.go:86-89`、`src/lib/telegram.ts`
- 前端：`src/app/records/[id]/page.tsx`、`src/components/records-table.tsx:52`
