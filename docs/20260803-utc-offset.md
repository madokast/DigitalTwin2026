# DigitalTwin2026：用隐列 `utc_offset` 还原带区的 `happened_at`

> 创建日期：2026-08-03  
> 状态：**已锁定，待实现**（本篇只定规格；**不**改代码）  
> 性质：Diataxis **explanation** + 锁定表  
> 相关：[`docs/20260729-schema-v1.md`](20260729-schema-v1.md)、[`docs/20260803-records-import-export.md`](20260803-records-import-export.md)、[`docs/20260801-api-layering.md`](20260801-api-layering.md)、OpenAPI `Record`、`src/lib/record.ts` / Go `record.FormatHappenedAt`

## 0. 一句话结论

`happened_at` **继续**用 `timestamptz` 存绝对瞬间；另加服务端私有列 **`utc_offset`**（offset **字面量**，非 IANA）。对外 JSON / JSONL **永远只有**带区的 `happened_at`，**看不到** `utc_offset`。读路径用「瞬间 + `utc_offset`」格式化，**停止**默认统一成 `…Z`。

---

## 1. 已锁定决策

| # | 决策 |
|---|------|
| 1 | **`happened_at` 列**仍为 `timestamptz`；落库绝对瞬间行为**不变**（排序、`from`/`to`、比较语义不变）。 |
| 2 | **新列名 `utc_offset`**（**不要**用 `time_zone`）：存录入时从 `happened_at` **字符串**解析出的 **UTC offset 字面量**，**不是** IANA。 |
| 3 | **对外完全不可见**：请求体、响应体、OpenAPI `Record`、import/export JSONL **均无** `utc_offset` 键；仅服务端读写隐列。 |
| 4 | **导入 / 导出**：文件里只有带时区的 `happened_at`；导入时拆 offset → 写 `utc_offset`；导出时用 `utc_offset` 格式化 `happened_at`。 |
| 5 | **规范化（易解析 / 易还原）**：见 §3。紧凑 `+0800` → `+08:00`；**`Z` ≠ `+00:00`**，禁止互相折叠。 |
| 6 | **无历史数据**可迁；空库 / 新库即可。手改 DB **不管**。 |
| 7 | **读路径**：停用默认 `toISOString()` / 一律 `Z`；对外 `happened_at` = 瞬间按 `utc_offset` 格式化。 |
| 8 | **复盘 API**仍暂停（见根 [`AGENTS.md`](../AGENTS.md)）。 |
| 9 | **JSON 键名**一律 `snake_case`（见 AGENTS）；本隐列本就不进 JSON。 |

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

- **客户端契约**：仍然只有一个时间键 `happened_at`（写啥区、读回同规范区）。  
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
请求 JSON：{ "happened_at": "<ISO 带区>", … }   // 无 utc_offset 键；若出现 → 未知键 400
        │
        ▼
parseHappenedAt(str) → Date（绝对瞬间）
extract + normalize → utc_offset 字面量（§3）
        │
        ▼
INSERT records (happened_at timestamptz, utc_offset text, …)
        │
        ▼
响应：fromDB → happened_at 用瞬间 + utc_offset 格式化（§6）
```

要点：

- 仍只接受现网允许的带区 ISO；瞬间入库行为与今日相同。  
- **禁止**客户端传 `utc_offset`（未知键拒绝，与其它隐字段策略一致）。  
- Todo / 体重 / 账单等所有经 draft 写 `records` 的路径同一套拆分逻辑。

---

## 6. 读出流程（列表、单条、Notify 文案等）

```text
SELECT …, happened_at, utc_offset, …
        │
        ▼
formatHappenedAt(happened_at, utc_offset)
  - utc_offset = 'Z'     → 该瞬间的 UTC 墙钟 + 'Z'
  - 否则                 → 该瞬间在该固定 offset 下的墙钟 + '±HH:MM'
        │
        ▼
对外 Record.happened_at（及 Todo deform 的 created_at，若源自同一列）
```

**停止**：`Date.toISOString()` / Go 侧等价「一律 UTC Z」作为 Record 对外默认。

查询参数 `from` / `to`、列表排序：仍只对 **瞬间** 比较；**不**因 `utc_offset` 改变区间语义。

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
| fixtures / 契约测 | 读路径样例可含 `+08:00`；写路径继续接受 `Z` / `±HH:MM` / `±HHMM`。 |
| Next + Go | schema / migration、`formatHappenedAt`、draft、import/export、Admin PATCH **双端同构**（见 api-layering）。 |
| JSON 键 | 仍一律 snake_case；隐列不序列化即可。 |

---

## 10. 非目标

- 不实现复盘 API。  
- 不存 IANA；不根据 offset 反推时区名。  
- 不做历史行回填 / 猜测旧数据的录入区。  
- 不把 `utc_offset` 暴露给前端 Settings 或 AI tool schema。  
- 不改变 `from`/`to` 必须带区的查询校验。

---

## 11. 实现时注意（本篇不落地代码）

1. Migration：`records.utc_offset text NOT NULL` + 可选 CHECK；空库直接加。  
2. 收敛所有 `formatHappenedAt` / `FormatHappenedAt` / Notify 内联格式化，避免漏网 `toISOString()`。  
3. 更新 import-export 文档中「读出 UTC Z」句子；可选在 AGENTS「Neon / 数据库」旁加 pointer（见根 AGENTS）。  
4. 单测：`Z` vs `+00:00` 不折叠；`+0800` → 存 `+08:00`；export/import round-trip；未知键 `utc_offset` → 400。
