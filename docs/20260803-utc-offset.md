# DigitalTwin2026：用隐列 `utc_offset` 还原带区的 `happened_at`

> 创建日期：2026-08-03  
> 状态：**已锁定；实现阶段见 §12**（规格已定；按阶段落地代码，勿一次巨型 PR）  
> 性质：Diataxis **explanation** + 锁定表  
> 相关：[`docs/20260729-schema-v1.md`](20260729-schema-v1.md)、[`docs/20260803-records-import-export.md`](20260803-records-import-export.md)、[`docs/20260801-api-layering.md`](20260801-api-layering.md)、OpenAPI `Record`、`src/lib/record.ts` / Go `record.FormatHappenedAt`

## 0. 一句话结论

`happened_at` **继续**用 `timestamptz` 存绝对瞬间；另加服务端私有列 **`utc_offset`**（offset **字面量**，非 IANA）。对外 JSON / JSONL **看不到** `utc_offset`；时间值用「瞬间 + `utc_offset`」格式化，**停止**默认统一成 `…Z`。键名因域而异（默认 `happened_at`；Todo 等变形为 `created_at`），**时区逻辑同一套**（见 §6.1）。

---

## 1. 已锁定决策

| # | 决策 |
|---|------|
| 1 | **`happened_at` 列**仍为 `timestamptz`；落库绝对瞬间行为**不变**（排序、`from`/`to`、比较语义不变）。 |
| 2 | **新列名 `utc_offset`**（**不要**用 `time_zone`）：存录入时从**时间 ISO 字符串**解析出的 **UTC offset 字面量**，**不是** IANA。 |
| 3 | **对外完全不可见**：请求体、响应体、OpenAPI `Record` / `TodoRecord`、import/export JSONL **均无** `utc_offset` 键；仅服务端读写隐列。 |
| 4 | **导入 / 导出**：文件里只有带时区的 `happened_at`（Record 形，无 Todo deform）；导入时拆 offset → 写 `utc_offset`；导出时用 `utc_offset` 格式化 `happened_at`。 |
| 5 | **规范化（易解析 / 易还原）**：见 §3。紧凑 `+0800` → `+08:00`；**`Z` ≠ `+00:00`**，禁止互相折叠。 |
| 6 | **无历史数据**可迁；空库 / 新库即可。手改 DB **不管**。Schema 变更：**不加**增量 Migration；**改基准建表 SQL / Drizzle schema 后 drop 表重建**（见 §11）。 |
| 7 | **读路径**：停用默认 `toISOString()` / 一律 `Z`；对外时间串 = 瞬间按 `utc_offset` 格式化——无论 JSON 键是 `happened_at` 还是变形后的 `created_at`。 |
| 8 | **复盘 API**仍暂停（见根 [`AGENTS.md`](../AGENTS.md)）。 |
| 9 | **JSON 键名**一律 `snake_case`（见 AGENTS）；本隐列本就不进 JSON。 |
| 10 | **键名变形 ≠ 时区例外**：Todo 等把库列时间对外叫 `created_at`（请求亦用 `created_at`），**仍**走同一套 extract / normalize / format；禁止 deform 路径偷偷改回一律 `Z`。 |

---

## 2. 为什么需要这一列（与洁癖）

### 2.1 硬限制

PostgreSQL `timestamptz` 只保证**绝对瞬间**。写入 `2026-08-03T08:00:00+08:00` 后，读回再 `toISOString()` / 驱动默认序列化，会变成 UTC `…Z`，**无法**稳定还原录入时的 `+08:00`。

### 2.2 否决的脏方案

| 方案 | 为何否决 |
|------|----------|
| `happened_at` + `happened_at_raw`（公开双胞胎） | 对外多一列「原文影子」，字段语义叠床架屋；**洁癖不接受**。 |
| `happened_at` 改成 `text` 存整串 ISO | 虽单列，但时间轴靠反复 `::timestamptz` 铸造；与现网瞬间语义、索引习惯分叉更大。 |
| 列名 `time_zone` 却存 offset / 或存 IANA | offset **推不出**唯一 IANA；名字撒谎。锁定用 **`utc_offset`**。 |

### 2.3 洁癖友好的折中

- **客户端契约**：每条记录对外仍只有**一个**时间值键（默认 `happened_at`；Todo 行为 `created_at`），写啥区、读回同规范区；**从不**另给 `utc_offset`。  
- **库内**：`timestamptz` 管瞬间 + **一列私有** `utc_offset` 管字面量；**不是**「正式时间 + raw 双胞胎」那种对外双字段。  
- 隐列不进 OpenAPI / JSONL，避免 API 表面膨胀。

---

## 3. `utc_offset` 规范化

从输入 `happened_at` 字符串末尾拆出时区后缀后，**入库前**规范成下列之一（大小写：输入 `Z`/`z` → 存 **`Z`**）：

| 输入后缀 | 存入 `utc_offset` | 读出 `happened_at` 后缀 |
|----------|-------------------|-------------------------|
| `Z` / `z` | `Z` | `…Z` |
| `+00:00` / `-00:00`（若解析接受） | `+00:00`（符号与分钟按解析结果；**不**改成 `Z`） | `…+00:00`（或对应 `-00:00`，若接受） |
| `+0800` / `-0430`（紧凑） | `+08:00` / `-04:30` | 同左 |
| 已是 `±HH:MM` | 原样该规范形（两位时、两位分、带冒号） | 同左 |

**硬规则：`Z` 与 `+00:00` 不同。** 输入 `Z` → 存 `Z`，输出可用 `…Z`；输入 `+00:00` → 存 `+00:00`，输出带 `+00:00`。**禁止**互相折叠。

非法 / 无时区后缀：仍走现有 draft 校验（须带 `Z` 或 `±HH:MM` / `±HHMM`），400，不落库。

建议实现时抽双端同构 helper（示意名）：`extractUtcOffsetLiteral(happenedAtStr) → canonical`；`formatHappenedAt(instant, utcOffset) → string`。

---

## 4. 列类型建议

| 项 | 建议 |
|----|------|
| 类型 | **`text NOT NULL`** |
| 合法值 | 仅规范形：`Z`，或 `^[+-]\d{2}:\d{2}$`（如 `+08:00`、`-04:30`、`+00:00`） |
| DB CHECK（可选但推荐） | `CHECK (utc_offset = 'Z' OR utc_offset ~ '^[+-][0-9]{2}:[0-9]{2}$')` |
| 应用层 | **必须**校验：拆分 + 规范化 + 拒绝非法；CHECK 只是安全网，不能替代解析 |
| 默认值 | **不要**依赖 DB default 猜区；每条写入路径显式写入。空库新列可 `NOT NULL`（无历史行） |
| 索引 | **不**为 `utc_offset` 建业务索引；时间轴仍用 `happened_at` |

手改 DB 导致 `utc_offset` 与瞬间「语义不一致」：产品**不管**（锁定 #6）。

---

## 5. 写入流程（POST log / 等价 draft）

```text
请求 JSON：时间键 = happened_at 或（Todo）created_at
           值 = "<ISO 带区>"     // 无 utc_offset 键；若出现 → 未知键 400
        │
        ▼
parseHappenedAt(str) → Date（绝对瞬间）
extract + normalize → utc_offset 字面量（§3）
        │
        ▼
INSERT records (happened_at timestamptz, utc_offset text, …)
        │
        ▼
响应：fromDB / Todo deform → 时间值用瞬间 + utc_offset 格式化（§6）
```

要点：

- 仍只接受现网允许的带区 ISO；瞬间入库行为与今日相同。  
- **禁止**客户端传 `utc_offset`（未知键拒绝，与其它隐字段策略一致）。  
- Todo 请求用 **`created_at`**（禁止同请求再带 `happened_at`）：从 **`created_at` 字符串**拆 offset，写入同一隐列 `utc_offset`。  
- 体重 / 账单 / text / number 等用 **`happened_at`** 的路径：同一套拆分逻辑。

---

## 6. 读出流程（列表、单条、Notify 文案等）

```text
SELECT …, happened_at, utc_offset, …
        │
        ▼
formatHappenedAt(happened_at, utc_offset)   // 唯一格式化入口
  - utc_offset = 'Z'     → 该瞬间的 UTC 墙钟 + 'Z'
  - 否则                 → 该瞬间在该固定 offset 下的墙钟 + '±HH:MM'
        │
        ▼
放入对外 JSON：
  - 默认 Record / 导出 JSONL     → 键名 happened_at
  - TodoRecord（创建成功 / query 待办行）→ 键名 created_at（值同上式，禁止改回一律 Z）
```

**停止**：`Date.toISOString()` / Go 侧等价「一律 UTC Z」作为对外时间默认。

查询参数 `from` / `to`、列表排序：仍只对 **瞬间** 比较；**不**因 `utc_offset` 改变区间语义。

### 6.1 键名变形与时区（锁定）

部分 API 把库列时间**换键名**对外（真源见 [`docs/20260802-todo-feature.md`](20260802-todo-feature.md)）：

| 场景 | 请求时间键 | 响应时间键 | 库列 | `utc_offset` |
|------|------------|------------|------|--------------|
| 普通 Record（log/text、number、query 非待办、导出…） | `happened_at` | `happened_at` | `happened_at` | 读写同一套 |
| Todo 创建 / query 待办行 deform | `created_at` | `created_at` | `happened_at` | **同一套**；值带区，逻辑与 `happened_at` 响应一致 |
| Todo transition 审计等非待办行 | （各 API 自有） | 默认 `happened_at` | 同上 | 同上 |

**硬规则：** deform **只改 JSON 键名**（及 Todo 的 `content` 等），**不改**「瞬间 + `utc_offset` → 带区 ISO」的格式化。实现上 `toTodoRecordJson` / Go `TodoRecordJSON` 必须调用与 `fromDB` **同一** `formatHappenedAt(…, utc_offset)`，禁止 Todo 路径单独 `toISOString()`。

若将来复盘等再引入「时间键别名」，同样遵守本条，不另开时区语义。

---

## 7. PATCH（`PATCH /api/admin/records/:id`）

| 请求是否带 `happened_at` | 行为 |
|--------------------------|------|
| **带**（合法带区串） | 更新 `happened_at` 瞬间；**同时**按新字符串重算并写入 `utc_offset`。 |
| **不带** | 不改 `happened_at`，也**不**改 `utc_offset`。 |
| 带 `utc_offset` 键 | **未知键 → 400**（隐列不可写）。 |

响应里的 `happened_at` 仍按更新后的隐列格式化。其它可 PATCH 字段语义不变。

---

## 8. 导入 / 导出

与 [`docs/20260803-records-import-export.md`](20260803-records-import-export.md) 对齐，并**修正**该文里「读出为 UTC `…Z`」的旧叙述（实现本规格后以本文为准）。

| 方向 | 文件中的键 | 服务端 |
|------|------------|--------|
| **导出** | 仅 OpenAPI `Record` 形；`happened_at` 已按 `utc_offset` 带区格式化；**无** `utc_offset` | `SELECT` 含隐列，序列化时丢弃 |
| **导入** | 同行：只有带区 `happened_at`；若行内出现 `utc_offset` → **字段级 400**（与未知键一致） | 解析瞬间 + 拆 offset 写入两列；upsert on `id` 时两列一并覆盖 |

Round-trip 期望：导出再导入，瞬间相等，且 `utc_offset` 规范形一致（紧凑输入会先在首次写入时规范化，故第二次起稳定为带冒号形）。

---

## 9. 契约与双端

| 层 | 要求 |
|----|------|
| OpenAPI `Record` | **不**增加 `utc_offset`；`happened_at` 描述改为「带显式区的 ISO；读出保留录入规范区（`Z` 与 `±HH:MM`），**不再**承诺一律 `Z`」。 |
| OpenAPI `TodoRecord` | **不**增加 `utc_offset`；`created_at` 描述与上同语义（带区读出）；注明与库列 `happened_at` + 隐列 `utc_offset` 同源格式化。 |
| fixtures / 契约测 | Record / TodoRecord 读路径样例可含 `+08:00`；写路径继续接受 `Z` / `±HH:MM` / `±HHMM`（Todo 写在 `created_at`）。 |
| Next + Go | schema（基准建表，**无**增量 migration）、`formatHappenedAt`、draft、Todo deform、import/export、Admin PATCH **双端同构**（见 api-layering）。 |
| JSON 键 | 仍一律 snake_case；隐列不序列化即可。 |

---

## 10. 非目标

- 不实现复盘 API。  
- 不存 IANA；不根据 offset 反推时区名。  
- 不做历史行回填 / 猜测旧数据的录入区；**不做** `ALTER TABLE … ADD COLUMN` 式增量 Migration。  
- 不把 `utc_offset` 暴露给前端 Settings 或 AI tool schema。  
- 不改变 `from`/`to` 必须带区的查询校验。

---

## 11. 实现时注意（摘要；分阶段见 §12）

1. **Schema：不要加新的 drizzle Migration 文件。** 直接改基准定义（如 `src/db/schema.ts` + `drizzle/0000_*.sql` 或仓库约定的唯一建表源），为 `records` 增加 `utc_offset text NOT NULL` + 可选 CHECK；本地 / 测试库 **DROP `records`（或整库）后按基准重建**。无生产数据、无回填。  
2. 收敛所有 `formatHappenedAt` / `FormatHappenedAt` / Notify / **Todo deform** 内联格式化，避免漏网 `toISOString()`。  
3. 更新 import-export、todo 规格中「读出 UTC Z」句子；可选在 AGENTS「Neon / 数据库」旁加 pointer（见根 AGENTS）。  
4. 单测：`Z` vs `+00:00` 不折叠；`+0800` → 存 `+08:00`；export/import round-trip；未知键 `utc_offset` → 400；**Todo `201.record.created_at` 与 query 待办行带区且与隐列一致**。  
5. 部署/collect 若仍提示 `db:migrate`：本变更语境下等同「用更新后的基准 schema 重建空库」，**不要**指望只跑一条 ADD COLUMN migration。

落地拆分、过渡窗口与验收勾选见 **§12**。

---

## 12. 实现阶段

> 把 §1–§10 拆成可独立 merge / 验收的阶段。**不写**逐文件实现细节；执行时另开会话按阶段落地。  
> **顺序理由：** 先双端纯函数 helper（无 schema）→ 改基准 schema 并写清 drop 重建（**无** ADD migration）→ 创建写入路径显式写隐列且响应已带区 → 读路径全收敛（禁漏网 `toISOString`）→ PATCH + import/export → OpenAPI 描述与旧「一律 Z」文档收尾。  
> **硬约束（全程）：** 不加增量 Migration；对外 JSON/JSONL **无** `utc_offset`；`Z` ≠ `+00:00`；复盘 API 仍暂停；双端同构 + snake_case。

### 过渡窗口

| 窗口 | 行为 | 说明 |
|------|------|------|
| 仅阶段 1 已合 | 有 extract / format 单测；**写读仍旧**（多半一律 `Z`） | 对外契约不变；可单独 merge |
| 阶段 2 已合、3 未合 | 基准 schema 含 `utc_offset NOT NULL`，但 INSERT 未写该列 | **危险中间态**：drop 重建后创建路径会炸。**禁止**长期停留；合入须 **2→3 紧耦合**（同日连续 PR，或同 PR） |
| 阶段 3 已合、4 未合 | 创建响应已带区；列表 / Notify / 部分 deform 仍可能漏网 `Z` | 可测 POST；勿宣称「读路径全带区」 |
| 阶段 4 已合、5 未合 | query / fromDB / Todo deform / Notify 已 format；PATCH / import/export 仍旧语义或漏隐列 | 主读路径 OK；Admin 改时间 / 备份恢复未齐 |
| 阶段 5 已合、6 未合 | 行为与 round-trip 齐；OpenAPI / 旧文档句可能仍写「一律 Z」 | 以本篇规格为准；阶段 6 收口描述 |

禁止：只合 Next 不合 Go；只改 schema 长期不接写入；加 `ALTER … ADD COLUMN` migration；把 `utc_offset` 暴露进 OpenAPI / JSONL。

---

### 阶段 1：双端 offset helper + 单测（尚无 schema）

**状态：已完成**

**目标：** 双端同构 `extract`/`normalize` 与 `formatHappenedAt(instant, offset)`，用单测锁住 §3 规则（含 `Z` ≠ `+00:00`、`+0800`→`+08:00`）。

**范围：**
- Next / Go：从带区 ISO 拆后缀 → 规范形；`formatHappenedAt` / `FormatHappenedAt`（或等价 stem）按隐列还原带区串
- 共享或镜像 fixture：`Z`、`+00:00`、`-00:00`（若接受）、紧凑 `±HHMM`、已是 `±HH:MM`、非法/无后缀
- 纯函数单测；**不**改 DB schema、**不**改 HTTP handler 默认行为（可暂未接线）

**落地：**
- Next：`src/lib/utcoffset.ts`（`extractUtcOffsetLiteral` / `formatHappenedAt(instant, utcOffset)`）
- Go：`faas/internal/utcoffset`（`ExtractUtcOffsetLiteral` / `FormatHappenedAt`）
- 共享 fixture：`testdata/utc-offset-cases.json`；尚未接线 `record` / draft / route

**不做什么：**
- 不加 `utc_offset` 列；不改 draft / route / OpenAPI
- 不实现复盘；不引入 IANA
- 不借机大改 import/export / PATCH

**验收标准：**
- [x] `Z` 与 `+00:00` **不**互相折叠（存与 format 往返各自保留）
- [x] 紧凑 `+0800` / `-0430` → 规范 `+08:00` / `-04:30`
- [x] `formatHappenedAt`：同一瞬间 + 不同 offset 产出对应墙钟后缀（含 `…Z`）
- [x] 非法 / 无时区后缀：与现网 draft 拒绝语义对齐（或本阶段明确抛错类型，由阶段 3 接到 400）
- [x] `npm test`（相关）与 `cd faas && go test`（相关包）绿

**依赖 / 可并行：** 无前置。与**阶段 2 可并行**开发/开 PR（文件面基本不重叠）。阶段 3+ 依赖本阶段。

---

### 阶段 2：基准 Schema 加列 + drop 重建说明（无 ADD migration）

**状态：已完成**

**目标：** 在基准建表源为 `records` 增加 `utc_offset text NOT NULL`（可选 CHECK）；文档写清 drop 重建步骤；**零**增量 Migration 文件。

**范围：**
- Drizzle schema + `drizzle/0000_*.sql`（或仓库唯一建表源）加列；可选 `CHECK (utc_offset = 'Z' OR utc_offset ~ '^[+-][0-9]{2}:[0-9]{2}$')`
- 本篇 / schema-v1 / 开发者向说明：本地与测试库 **DROP `records`（或整库）后按基准重建**；无历史回填；deploy/collect 语境下「migrate」= 重建空库，**不要**指望 ADD COLUMN
- 确认**未**新增 `drizzle/000N_*.sql` 之类增量文件

**落地：**
- Next：`src/db/schema.ts` + 基准 `drizzle/0000_many_invaders.sql` + 同版本 `drizzle/meta/0000_snapshot.json`（**无** `0001_*`）
- 列：`utc_offset text NOT NULL`；CHECK `chk_utc_offset`（`Z` 或 `^[+-][0-9]{2}:[0-9]{2}$`）
- 写入路径仍未显式写该列（阶段 3）；TS insert 仅用类型断言过编译——**须紧接阶段 3**

#### Drop 重建步骤（本地 / 测试库；无历史回填）

> **禁止** `ALTER TABLE … ADD COLUMN` 与新增量 drizzle migration。已跑过旧 `0000` 的库不会因改基准 SQL 自动变列；必须 drop 后按更新后的 `0000` 重建。

```bash
# 1) 指向测试库（host/库名须含 test / TestDigitalTwin）
export DATABASE_URL='…'   # 或依赖 .env.test

# 2) 丢掉旧表（无生产数据；可整库 drop 再建）
psql "$DATABASE_URL" -c 'DROP TABLE IF EXISTS records CASCADE;'
# 若 drizzle 元表也需重跑 0000：一并清 journal
psql "$DATABASE_URL" -c 'DROP TABLE IF EXISTS drizzle.__drizzle_migrations CASCADE;'
# 部分环境 schema 名为 drizzle；若上面失败可：
# psql "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS drizzle CASCADE;'

# 3) 按仓库唯一基准建表源重建
npm run db:migrate

# 4) 可选核对
npm run db:check
```

deploy / `collect-prod-env` 若仍问 `db:migrate`：本变更语境下等同「空库用更新后的 `0000` 起表」，**不要**指望一条 ADD COLUMN migration。

**不做什么：**
- 不做 `ALTER TABLE … ADD COLUMN` migration
- 不改运行时 format 接线（留给 3–4）；不改 OpenAPI 描述（留给 6）
- 不要求本阶段单独把生产写路径跑绿（见过渡窗口：须紧接阶段 3）

**验收标准：**
- [x] 基准 schema / `0000` 含 `utc_offset text NOT NULL`（+ 可选 CHECK）；**无**新增量 migration
- [x] 文档明确 drop 重建步骤与「无 ADD migration」禁令（可指向本篇 §11 / 本阶段）
- [x] 空库按基准重建可起表（手工或现有 db 脚本验证）

**依赖 / 可并行：** 与**阶段 1 可并行**。**合入后必须紧接阶段 3**（或同 PR 含写入）；勿在「仅有列、无写入」上对外停留。

---

### 阶段 3：写入路径（创建 draft / log / todo）

**状态：已完成**

**目标：** 所有创建写入显式落 `utc_offset`；创建成功响应时间值已按隐列带区格式化；请求体出现 `utc_offset` → 未知键 400。

**范围：**
- Next + Go：体重 / 账单 / text / number / Todo 等 POST（及等价 draft）路径：parse 瞬间 + extract/normalize → INSERT 两列
- Todo：从 **`created_at`** 字符串拆 offset，写入同一隐列；响应 `created_at` 走同一 `formatHappenedAt`
- 创建响应 `fromDB` / 等价序列化已用 format（至少本阶段覆盖的写成功路径）
- 未知键 `utc_offset` 拒绝（与其它隐字段策略一致）
- 双端测：带 `+08:00` / `Z` / 紧凑后缀创建后读回规范形；Todo `201.record.created_at` 带区

**不做什么：**
- 不收敛尚未改到的列表 query / Notify 漏网（阶段 4）——注：`fromDB` 已按隐列格式化，query/export SELECT 已带 `utc_offset` 以免签名断裂；Notify / telegram 本地 format、recordjsonl **导出**一律 Z 等仍留给阶段 4/5
- 不改 Admin PATCH 同步改 `utc_offset`（阶段 5）；import upsert **本阶段已写隐列**（否则 NOT NULL 无法落库）
- 不改 OpenAPI 叙述句（阶段 6；测可用字面断言）
- 不实现复盘 API

**验收标准：**
- [x] 各创建路径 INSERT 均显式写 `utc_offset`；无依赖 DB default 猜区
- [x] 创建成功 JSON：**无** `utc_offset` 键；时间键（`happened_at` 或 Todo `created_at`）带录入规范区
- [x] 请求带 `utc_offset` → 400（英文错误，snake 字段名若提及则一致）
- [x] 本地/测试库已按阶段 2 重建后，相关 `npm test` / `go test` / 有 DB 集成测绿

**依赖 / 可并行：** **依赖阶段 1 + 2**（逻辑 + 列）。与阶段 4 **文件面可部分并行**，但建议 **先合 3 再合 4**（先保证写入不炸）。勿与阶段 2 长期拆开合入。

---

### 阶段 4：读路径收敛（query / fromDB / Todo deform / Notify）

**状态：未开始**

**目标：** 一切对外时间串经 `formatHappenedAt(instant, utc_offset)`；禁漏网 `toISOString()` / Go 一律 `Z`；deform **只改键名**不改时区语义。

**范围：**
- `fromDB` / query 列表与单条、Todo deform（待办行 `created_at`）、Notify 文案中的时间、其它内联序列化
- 审计 grep / 双端测：生产读路径无默认 `toISOString`（或等价）作为对外时间
- `from` / `to` 查询与排序仍只比瞬间（行为不变）

**不做什么：**
- 不改 PATCH / import/export 写入隐列（阶段 5；若 export 已走 fromDB 则本阶段顺带受益，但 upsert 写入留给 5）
- 不改 OpenAPI 描述长文（阶段 6）
- 不把隐列暴露给客户端

**验收标准：**
- [ ] query 非待办行 `happened_at`、待办行 `created_at` 均带区且与隐列一致
- [ ] Notify 所用时间串与 format 一致（`SUPPRESS_BOT_NOTIFICATION=1` 下可断言 schedule 载荷）
- [ ] 双端无「读路径漏网一律 Z」；相关单测 / 契约测绿
- [ ] §6.1：deform 仅键名；与 `fromDB` 共用同一 format 入口

**依赖 / 可并行：** **依赖阶段 3**（库内行已有可靠 `utc_offset`；创建路径已示范接线）。与阶段 5 **可并行开发**（读收敛 vs Admin/IO），合入建议先 4 后 5 或同迭代紧接。

---

### 阶段 5：PATCH + import / export

**状态：未开始**

**目标：** Admin PATCH 带/不带 `happened_at` 按 §7 更新隐列；导入拆 offset 写入、导出按隐列格式化；round-trip 瞬间与规范 offset 一致；文件/请求均无 `utc_offset` 键。

**范围：**
- `PATCH /api/admin/records/:id`：带合法带区串 → 更新瞬间 + 重算 `utc_offset`；不带 → 两列都不动；带 `utc_offset` 键 → 400
- export：`SELECT` 含隐列，序列化丢弃；`happened_at` 已 format
- import：仅带区 `happened_at`；行内 `utc_offset` → 字段级 400；upsert 两列一并覆盖
- 双端测：PATCH 矩阵；export/import round-trip；紧凑输入首次规范化后第二次稳定

**不做什么：**
- 不改基准 schema 策略；不加 migration
- 不借机做 gzip / 前端；不实现复盘
- 不把「旧文档一律 Z」收尾当成本阶段唯一交付（阶段 6；测断言以本篇为准）

**验收标准：**
- [ ] PATCH 行为符合 §7；响应 `happened_at` 按更新后隐列 format
- [ ] 导出 JSONL **无** `utc_offset`；`happened_at` 带区
- [ ] 导入拒绝行内 `utc_offset`；成功路径写入两列；round-trip 绿
- [ ] openapi 契约测若已断言时间形，与行为一致或本阶段同步改 fixture（描述句可留阶段 6）
- [ ] 双端相关测绿

**依赖 / 可并行：** **依赖阶段 1–3**（helper + 列 + 写入惯例）；**强依赖阶段 4** 才宣称「读出与导出全带区」无漏网（export 若仍绕过 fromDB 则本阶段必须自己接 format）。与阶段 4 **可并行开发**；合入建议 `4 → 5`。

---

### 阶段 6：OpenAPI 描述 + 文档收尾

**状态：未开始**

**目标：** OpenAPI `Record` / `TodoRecord` 时间字段描述改为「带显式区；读出保留规范区，**不再**承诺一律 `Z`」；import-export / todo 等旧句改正；本篇状态与 §12 勾选对齐终态。

**范围：**
- `openapi/components`（及 fixtures 样例可含 `+08:00`）；`npm run openapi:lint` / `test:openapi`
- [`docs/20260803-records-import-export.md`](20260803-records-import-export.md)、[`docs/20260802-todo-feature.md`](20260802-todo-feature.md) 中「读出 UTC Z / 一律 Z」冲突句 → 指向本篇
- 可选：根 AGENTS「Neon / 数据库」旁 pointer 复核
- 本篇状态改为「已落地」类表述；§12 阶段 1–6 勾选完成

**不做什么：**
- 不夹带行为变更；发现漏网回 1–5 修
- **不**在 OpenAPI 增加 `utc_offset` 属性
- 不新增大段重复规格

**验收标准：**
- [ ] OpenAPI：无 `utc_offset` 属性；`happened_at` / `created_at` 描述符合 §9
- [ ] import-export / todo 文档无「对外时间一律 Z」现行承诺
- [ ] `openapi:lint` + `test:openapi` + 契约相关测绿
- [ ] 本篇标记阶段 1–6 完成 / 状态与终态一致

**依赖 / 可并行：** **依赖阶段 1–5 均已合**（文档描述终态）。不可与行为阶段并行作为「唯一真源」提前合入。

---

### 建议落地顺序（总表）

| 顺序 | 阶段 | 可独立验收 | 依赖 | 与其它并行 |
|------|------|------------|------|------------|
| 1a | **阶段 1** 双端 helper + 单测 | 是（纯函数测） | — | 与阶段 2 **可并行** |
| 1b | **阶段 2** 基准 schema + drop 重建说明 | 是（schema / 空库重建） | — | 与阶段 1 **可并行**；合入后**紧接 3** |
| 2 | **阶段 3** 创建写入 + 响应带区 | 是（POST / draft 测） | 阶段 1+2 | 与 4 可部分并行开发；建议先合 3 |
| 3a | **阶段 4** 读路径收敛 | 是（query / Notify / deform） | 阶段 3 | 与阶段 5 **可并行开发** |
| 3b | **阶段 5** PATCH + import/export | 是（Admin + IO + round-trip） | 阶段 1–3；（宣称全读带区要 4） | 与阶段 4 **可并行**；建议先合 4 |
| 4 | **阶段 6** OpenAPI + 文档收尾 | 是（审阅 / openapi） | 阶段 1–5 | 不并行（收尾） |

**推荐合入节奏：**（`1` ∥ `2`）→ `3`（紧接 2）→（`4` ∥ `5` 开发，**建议先合 4 再合 5**）→ `6`。若只能串行：`1 → 2 → 3 → 4 → 5 → 6`。
