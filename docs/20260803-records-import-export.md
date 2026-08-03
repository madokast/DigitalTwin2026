# DigitalTwin2026：Records 导入 / 导出（规划）

> 创建日期：2026-08-03  
> 状态：**规划已定稿**（含审查 errata）；**实现未排期**  
> 性质：分块备份 / 迁移；**不做**前端 UI；**一期无 gzip**  
> 相关：[`docs/20260802-todo-feature.md`](20260802-todo-feature.md) §5.3、OpenAPI `Record` / `ApiToken`·`AdminToken`、`src/proxy.ts`、写路径 `draft` / `logapi`

## 0. 目标与非目标

**目标**

- 按 **`id ASC` 游标**分块导出 `records` 为 **JSONL 文件流**（下载）。
- 用同形状 JSONL **文件上传** + **按 `id` upsert** 写回。
- 形状 = OpenAPI **`Record` camelCase**：**禁止** Todo deform（`created_at` / `content`）。
- 成功后 **一律 Notify**（导出每页含 0 行；导入含空文件全 0）；**无** `suppress_notification` 字段。
- 实现时双端（Next + Go）+ OpenAPI 同构；本篇只规划。

**非目标**

- 前端导入/导出 UI。
- CSV / SQLite / gzip·tar（一期不做压缩）。
- 无参「全表一次导出」。
- 用导入替代日常 `/api/log/*`。
- 接受 Todo 变形 JSON。
- 本应用 **无 DELETE 行 API**（含 Admin）。

---

## 1. 已锁定产品决策

| # | 决策 |
|---|------|
| 1 | **无 JSON deform**；JSONL ↔ `Record` camelCase（§2）。 |
| 2 | **导出** = 文件下载流（NDJSON）；**导入** = multipart 文件上传。 |
| 3 | **导入 = upsert on `id`**；可重复导入。 |
| 4 | **导出鉴权** = `ApiToken`；**导入** = `AdminToken` only（`/api/admin/...`）。 |
| 5 | **Admin import 必须允许保留 tag**（跳过 `assertNoReservedTags`；PATCH 仍拒绝）。 |
| 6 | **始终 Notify**（含空导出 / 空导入）；本两 API **不**暴露 `suppress_notification`。 |
| 7 | **一期无压缩**；`MAX_HTTP_BODY_BYTES`（256KiB）**不**约束本两路由（须独立流式读，禁止误接 `readJsonBody` / 默认 `readBody`）。 |
| 8 | **流式 + 单事务**：边读边写均在**同一 DB 事务**内；**全部成功才 commit**；失败 **rollback** 且 **不** Notify。 |
| 9 | 本阶段只文档；实现另排期。 |

鉴权真源：`ApiToken` = `DIGITAL_TWIN_TOKEN` 或 `DIGITAL_TWIN_ADMIN_TOKEN`；`AdminToken` = 仅后者。见 `src/proxy.ts` / Go `httpx`。

---

## 2. Record JSONL 行形状与校验

### 2.1 表示层（文件中的键）

与 OpenAPI `Record` 一致（camelCase）：

| JSON 键 | 要点 |
|---------|------|
| `id` | UUID 字符串 |
| `happenedAt` | 可解析为带时区时间；**写入语义对齐 draft/log**（允许 `+08:00` 等；存库后再按现网规范读出为 UTC `…Z`） |
| `valueNumber` | decimal **字符串**或 `null`；JSON **number 类型 → 400**（详细错误） |
| `valueText` | `string` 或 `null` |
| `tags` | **字符串**（JSON 数组字面量）；误传数组类型 → 400 |
| `objectiveContext` | 非空 string |
| `subjectiveInterpretation` | `string` 或 `null` |

出现 `created_at` / `content` / 未知键 → **字段级详细英文错误**（含行号）。

### 2.2 语义校验（对齐写路径，表示层例外）

| 规则 | 行为 |
|------|------|
| 字段完备性 / 双 null / 时间可解析 | 与 `draft` / log / Admin PATCH **写校验语义对齐** |
| `tags` 字符串 | `JSON.parse` → `string[]` 后走 **`validateTags` / `isValidTag`**（非空、字符集） |
| **保留 tag** | import **跳过** `assertNoReservedTags`（可写 `todo:*` / `transaction_entry*` / `body:weight*` 等） |
| `id` | 合法 UUID；非法 → **400**（文案与 Admin 对齐倾向，如含 `Invalid record id`）；**不**强制 UUIDv7 |

实现时附 **最小 round-trip fixture**（export 一行再 import）双端同测。

---

## 3. 路径

| 操作 | 路径 | 方法 | 鉴权 |
|------|------|------|------|
| 导出 | `GET /api/export/records` | GET | ApiToken |
| 导入 | `POST /api/admin/import/records` | POST | AdminToken |

禁止把导出挂到 `/api/admin/...`。

---

## 4. 导出（游标分页 + 文件下载）

### 4.1 查询参数

| 参数 | 必填 | 规则 |
|------|------|------|
| `from` | 否 | 合法 UUID。省略 = **请求时刻**表中最小 `id`。 |
| `limit` | **是** | 整数 **1 ≤ limit ≤ 1000**；缺省或越界 → **400**（文案写明范围）。 |

| `from` 情况 | HTTP | 错误语义（英文终稿实现期定，须可区分） |
|-------------|------|------------------------------------------|
| 非法 UUID（格式错） | **400** | 与「不存在」不同文案（对齐 Admin：倾向 `Invalid record id` 一类） |
| 合法但行不存在 | **404** | 如 `export from id not found` |

语义：`WHERE id >= :from`（有 `from`）`ORDER BY id ASC` `LIMIT :limit`（**含**起点）。

**为何不用 `happened_at` 窗：** 可任意填写，无法保证扫全表；按 `id` 游标做分块备份。日常服务端发号多为 UUIDv7≈插入序；import 允许自定义 UUID，见 §4.4。

### 4.2 结束条件（客户端自理）

API **不**规定官方结束协议。常用启发：行数 `< limit` 可视为无下一页；`= limit` 时用最后一行 `id` 作下一 `from`（**重叠**一行，upsert 消化）。OpenAPI description 注明末页后再请求常得 1 行重叠 + 再一次 Notify，属预期。

### 4.3 响应

- **200**：JSONL 流（可 0 行空 body）；空库无 `from` 亦然。  
- 空 body 仍带 `Content-Type: application/x-ndjson` 与 `Content-Disposition`。  
- `Content-Disposition: attachment; filename="…"`  
- **不要** `X-Export-*` 头；**不要** JSON 信封。

| 情形 | 文件名 |
|------|--------|
| 有 `from` | `records-from-{uuid}-limit-{n}-{ts}.jsonl` |
| 无 `from` | `records-from-start-limit-{n}-{ts}.jsonl` |

`{ts}` = UTC `YYYYMMDDTHHMMSSZ`。

### 4.4 导出期间的并发（写清楚）

本应用**无 DELETE 行**（含 Admin）。多页 LOOP 期间可能发生：

| 并发操作 | 会发生什么 |
|----------|------------|
| **INSERT**（服务端新 UUIDv7，通常 **大于** 当前游标） | 后续页可能扫到「偏新」行；备份可略新于「开始时刻快照」。按 `from`+`limit` 前进时，**已走过的 id 窗口不会因该插入而漏掉旧行**。 |
| **INSERT / import 写入更小或乱序 `id`**（客户端指定 UUID） | 若新 id **小于** 当前页的 `from`，后续 LOOP **永远扫不到**该行 → **可能漏备份**。多页备份若同时有人 import 自定义 id，**不保证**全集覆盖。 |
| **Admin PATCH / todo transition 等 UPDATE** | 已导出页与未导出页内容可能来自不同时刻 → **非同一全局快照**；单页内仍是该次查询一致。 |
| **DELETE** | 产品无此 API；不作为设计前提。 |

**单页保证：** 一次请求内 `id >= from` 的查询结果，不漏该窗口内当时可见行。  
**多页 LOOP：** 在「仅追加更大 id」假设下可覆盖全表；存在自定义/乱序 id 或跨页 UPDATE 时，只保证尽力备份，**不**宣称「绝不丢数据 / 完美快照」。

### 4.5 流式与错误

1. 先鉴权 + 校验 `from`/`limit`（失败 → JSON `{ "error" }`，**不**开 JSONL，**不** Notify）。  
2. 再查库开流写 NDJSON。  
3. **开流后**若 DB/写失败：无法再改为 JSON 错误信封；结束响应；**不**发成功 Notify（截断不视为成功备份）。

### 4.6 Notify

每次导出请求成功结束（含 **0 行**）→ **Notify 一次**。文案含行数、`from` 或 start、`limit`（实现期润色）。**无** suppress。

---

## 5. 导入（multipart + 单事务流式 upsert）

### 5.1 请求

- `multipart/form-data`，字段名 **`file`**。忽略未知字段；多个 `file` → 400。  
- 接受：`application/x-ndjson`、`application/jsonl`，以及 `application/octet-stream`（filename 以 `.jsonl` 结尾）。  
- UTF-8 JSONL；**1-based 行号**；忽略空行；可选 strip UTF-8 BOM；忽略空行后 0 行 ≡ 空文件。

### 5.2 上限

| 限制 | 值 | 含义 |
|------|-----|------|
| 最大行数 | **1000**（非空行计数） | 超限 400，提示拆分 |
| 最大字节 | **4 MiB** = **`file` part 原始字节**（不含 multipart 外壳） | 超限 400，提示拆分 |

建议英文（双端终稿一致）：  
`import exceeds limits (max 1000 lines or 4 MiB); split the file`。  
校验顺序：实现时写死（建议先累计字节，再累计行；发现即报）。接近平台 body 上限，一期勿再加大。

### 5.3 Upsert 与保留 tag

- 存在 → 更新全部可编辑列；不存在 → INSERT 含给定 `id`。  
- **可写保留 tag**；格式仍须合法。  
- **不**因 import 自动插审计或走专用 API 副作用。

### 5.4 流式 + 单事务（定稿）

```
BEGIN
  按行：parse → 字段校验 → seen 查重 → upsert（同一 tx）
  全部成功 → COMMIT → 200 JSON 计数 → Notify
  任一步失败 → ROLLBACK → 400/5xx JSON 错误 → 不 Notify
```

- **禁止**逐行自动提交。  
- **禁止**整文件 `[]` 进内存；`seen` ≤ 1000 个 id。  
- 重复 `id` → 400，文案含该 uuid（可含行号）。

### 5.5 成功响应与 Notify

```json
{ "success": true, "inserted": 12, "updated": 3, "total": 15 }
```

- `total = inserted + updated`。  
- **判定：** 该 `id` 提交前不存在 → inserted；已存在 → updated（含「值未变仍算 updated」——实现简单、可测；若用 DB 行是否变更再议，默认 **存在即 updated**）。  
- **空文件 / 仅空行：** 200 + 全 0，**仍 Notify**（与「始终 Notify」、空导出一致）。

### 5.6 错误（面向 AI，尽量详细）

| 类别 | HTTP | 要求 |
|------|------|------|
| `from` 非法 UUID（导出） | 400 | 与 404 文案不同 |
| `from` 不存在（导出） | 404 | 如 `export from id not found` |
| `limit` 非法 | 400 | 写明 1…1000 |
| 超限 | 400 | 拆分提示 |
| 重复 id | 400 | **含该 uuid** |
| JSON/结构损坏 | 400 | **行号** + 原因 |
| 字段级 | 400 | **行号** + 字段 + 原因（越细越好） |
| multipart | 400 | 写明期望 |

---

## 6. 与 Todo deform / Admin PATCH

| 路径 | 行为 |
|------|------|
| Query / todo 创建成功 | 待办可 deform |
| Export / Import | 仅 Record 键；deform 键 → 详细 400 |
| Admin PATCH | 拒保留 tag |
| Admin **import** | **允许**保留 tag |

---

## 7. 实现约束（排期后）

1. OpenAPI + 双端 stem；错误字符串双端字节一致。  
2. 导入/导出路由 **bypass** 256KiB JSON body 门闸。  
3. 测试覆盖：游标重叠；from 400/404；limit；空导出/空导入均 Notify；事务失败无 Notify；重复 id；行级错误；保留 tag；鉴权矩阵；误接 readJsonBody 不得 413。  
4. FC 64MB：流式 + seen≤1000 + 4MiB。

---

## 8. 非目标复查

- 前端；gzip；无参全表；按 `happened_at` 切块。  
- Export JSON 信封 / X-Export 头；suppress。  
- Mirror 删除未出现在文件中的行。

---

## 9. 已拍板摘要

1. Path / 鉴权 / 无 deform / Admin 可写保留 tag / 无 suppress。  
2. 导出：`from?` + `limit`∈[1,1000]；非法 from→400、不存在→404；文件流；每页 Notify（含 0 行）。  
3. 导入：multipart；≤1000 行且 file part≤4MiB；**单事务流式** upsert；成功才 commit+Notify（**含空文件**）；失败回滚不 Notify。  
4. 校验：表示层 Record；语义对齐 draft；跳过保留 tag 拒绝。  
5. 并发：见 §4.4 表；不夸大「LOOP 绝不丢」。

---

## 10. 待拍板

**无。**（含 2026-08-03 审查 errata。）

实现期仅定错误字符串终稿与模块名。
