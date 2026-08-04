# DigitalTwin2026：Records 导入 / 导出

> 创建日期：2026-08-03  
> 状态：**已落地**（阶段 1–4 全部完成：共享 `recordjsonl` + `GET /api/export/records` + `POST /api/admin/import/records` + 文档收尾）  
> 性质：分块备份 / 迁移；**不做**前端 UI；**一期无 gzip**  
> 相关：[`docs/20260802-todo-feature.md`](20260802-todo-feature.md) §5.3、[`docs/20260803-suppress-bot-notification.md`](20260803-suppress-bot-notification.md)、[`docs/20260803-utc-offset.md`](20260803-utc-offset.md)、OpenAPI `Record` / `ApiToken`·`AdminToken`、`src/proxy.ts`、写路径 `draft` / `logapi`

## 0. 目标与非目标

**目标**

- 按 **`id ASC` 游标**分块导出 `records` 为 **JSONL 文件下载**（有界缓冲，见 §4.5）。
- 用同形状 JSONL **文件上传** + **按 `id` upsert** 写回（file part ≤4MiB 有界读入后逐行处理，见 §5.4）。
- 形状 = OpenAPI **`Record` snake_case**：**禁止** Todo deform（`created_at` / `content`）。
- 成功后 **一律 Notify**（导出每页含 0 行；导入含空文件全 0）；**无**请求体 `suppress_notification`。真发与否仅看进程 env `SUPPRESS_BOT_NOTIFICATION`（见 [`20260803-suppress-bot-notification.md`](20260803-suppress-bot-notification.md)）。
- 双端（Next + Go）+ OpenAPI 同构已落地；本篇为决策真源。

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
| 1 | **无 JSON deform**；JSONL ↔ `Record` snake_case（§2）。 |
| 2 | **导出** = NDJSON 文件下载（有界缓冲）；**导入** = multipart 文件上传。 |
| 3 | **导入 = upsert on `id`**；可重复导入。 |
| 4 | **导出鉴权** = `ApiToken`；**导入** = `AdminToken` only（`/api/admin/...`）。 |
| 5 | **Admin import 必须允许保留 tag**（跳过 `assertNoReservedTags`；PATCH 仍拒绝）。 |
| 6 | **始终 Notify**（含空导出 / 空导入）；本两 API **不**暴露 body `suppress_notification`；静音仅 env（见 [`20260803-suppress-bot-notification.md`](20260803-suppress-bot-notification.md)）。 |
| 7 | **一期无压缩**；`MAX_HTTP_BODY_BYTES`（256KiB）**不**约束本两路由（须独立有界读；禁止误接 `readJsonBody` / 默认 `readBody`）。 |
| 8 | **行级处理 + 有界缓冲 + 单事务**（**不是** DB cursor 边读边 chunk 刷 HTTP 的无限流）：导出先 `LIMIT` 查询再组 NDJSON；导入 file part ≤4MiB 读入后同一 tx 逐行 upsert；**全部成功才 commit**；失败 **rollback** 且 **不** Notify。 |
| 9 | 产品决策已定；**§11** 阶段 1–4 已全部完成。 |

鉴权真源：`ApiToken` = `DIGITAL_TWIN_TOKEN` 或 `DIGITAL_TWIN_ADMIN_TOKEN`；`AdminToken` = 仅后者。见 `src/proxy.ts` / Go `httpx`。

---

## 2. Record JSONL 行形状与校验

### 2.1 表示层（文件中的键）

与 OpenAPI `Record` 一致（snake_case）：

| JSON 键 | 要点 |
|---------|------|
| `id` | UUID 字符串 |
| `happened_at` | 可解析为带时区时间；**写入语义对齐 draft/log**（允许 `Z` / `±HH:MM` / `±HHMM`）。读出按隐列 `utc_offset` 保留录入规范区（`Z` 与 `±HH:MM`），**不再**一律 UTC `…Z`——见 [`docs/20260803-utc-offset.md`](20260803-utc-offset.md)。文件中**无** `utc_offset` 键 |
| `numeric_value` | decimal **字符串**或 `null`；JSON **number 类型 → 400**（详细错误） |
| `raw_content` | `string` 或 `null` |
| `tags` | **JSON 数组**（与 JSON API 一致，如 `["weight"]`）；import 同时兼容旧备份的**字符串化**数组（`"[\"weight\"]"`） |
| `objective_context` | 非空 string |
| `subjective_interpretation` | `string` 或 `null` |

出现 `created_at` / `content` / 未知键 → **字段级详细英文错误**（含行号）。

### 2.2 语义校验（对齐写路径，表示层例外）

| 规则 | 行为 |
|------|------|
| 字段完备性 / 双 null / 时间可解析 | 与 `draft` / log / Admin PATCH **写校验语义对齐** |
| `tags` | 数组或字符串化数组（双兼容）统一 `JSON.parse` → `string[]` 后走 **`validateTags` / `isValidTag`**（非空、字符集） |
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

- **200**：NDJSON 正文（可 0 行空 body）；空库无 `from` 亦然。  
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

### 4.5 有界缓冲与错误（非真 chunk 流）

实现是 **行级处理 + 有界缓冲**，**不是**「DB cursor 边读边按 chunk 刷 HTTP」的无限流：

1. 先鉴权 + 校验 `from`/`limit`（失败 → JSON `{ "error" }`，**不**写 NDJSON，**不** Notify）。  
2. 再 `ORDER BY id ASC LIMIT :limit`（≤1000）一次查出本页行，在内存组完整 NDJSON，再写出响应体。  
3. **响应体写出成功之后**才 Notify。若写出失败（或此前校验/查库失败）：**不**发成功 Notify（截断 / 失败不视为成功备份）。  
   - Go：`Write` 返回错误则 return，不调 `NotifyUser`。  
   - Next：构造成功 `NextResponse` 后再 `scheduleBestEffortNotify`（框架写失败不可在 handler 内观测，语义对齐「成功响应已就绪才 schedule」）。

### 4.6 Notify

每次导出请求**响应体成功写出后**（含 **0 行**）→ **Notify 一次**。文案含行数、`from` 或 start、`limit`。**无** body suppress；静音见 `SUPPRESS_BOT_NOTIFICATION`。

---

## 5. 导入（multipart + 有界读入 + 单事务逐行 upsert）

### 5.1 请求

- `multipart/form-data`，字段名 **`file`**。忽略未知字段（Go：非 `file` part 丢弃时有 **per-part 字节上限**，与 4MiB 同量级；超限 → 400）；多个 `file` → 400。  
- 接受：`application/x-ndjson`、`application/jsonl`，以及 `application/octet-stream`（filename 以 `.jsonl` 结尾）。  
- UTF-8 JSONL；**1-based 行号**；忽略空行；可选 strip UTF-8 BOM；忽略空行后 0 行 ≡ 空文件。

### 5.2 上限

| 限制 | 值 | 含义 |
|------|-----|------|
| 最大行数 | **1000**（非空行计数） | 超限 400，提示拆分 |
| 最大字节 | **4 MiB** = **`file` part 原始字节**（不含 multipart 外壳） | 超限 400，提示拆分 |
| 非 file part（Go） | **≤4 MiB**（`LimitReader` 丢弃） | 超限 400：`multipart non-file part exceeds size limit (max 4 MiB)` |

建议英文（file/行超限，双端一致）：  
`import exceeds limits (max 1000 lines or 4 MiB); split the file`。  
校验顺序：

- **Next**：`formData` 取 `file` 后先判 **`file.size`**（`> 4MiB` → 400），再 `file.text()` / 逐行 upsert（避免超限仍无界读全文）。  
- **Go**：`file` part 用 `LimitReader(…, 4MiB+1)`；非 `file` part 丢弃同样有界。  

接近平台 body 上限，一期勿再加大。

### 5.3 Upsert 与保留 tag

- 存在 → 更新全部可编辑列；不存在 → INSERT 含给定 `id`。  
- **可写保留 tag**；格式仍须合法。  
- **不**因 import 自动插审计或走专用 API 副作用。

### 5.4 有界缓冲 + 单事务（定稿）

**不是**边从 HTTP 无限流边 upsert 的真 chunk 流：先把 **`file` part（≤4MiB）**读入有界缓冲，再在**同一 DB 事务**内逐行处理。

```
读入 file part（≤4MiB；超限 400）
BEGIN
  按行：parse → 字段校验 → seen 查重 → upsert（同一 tx）
  全部成功 → COMMIT → 写出 200 JSON 计数 →（写出成功后）Notify
  任一步失败 → ROLLBACK → 400/5xx JSON 错误 → 不 Notify
```

- **禁止**逐行自动提交。  
- **禁止**把整文件解析成 `Record[]` 再一次性写库；允许 ≤4MiB 原文缓冲 + `seen` ≤ 1000 个 id。  
- 重复 `id` → 400，文案含该 uuid（可含行号）。  
- **失败 rollback 不 Notify**（与导出写出失败不 Notify 对称）。  
- **Notify 时机（与导出对齐）：** DB commit 成功且 **200 响应体写出成功之后**再 Notify。  
  - Go：`Encode` 成功后再 `NotifyUser`；写出失败则不 Notify（此时库已 commit，属极端网络失败）。  
  - Next：构造成功 `NextResponse.json` 后再 `scheduleBestEffortNotify`（框架层写出失败 handler 内不可观测，与 §4.5 导出相同）。

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
| 非 file part 超限（**仅 Go**） | 400 | `multipart non-file part exceeds size limit (max 4 MiB)` |

### 5.7 平台限制（无法在应用层消除；契约已写明）

| 限制 | 说明 |
|------|------|
| **Next `formData()`** | 运行时可能先缓冲**整包** multipart；handler 内 `file.size` 门闸只避免随后无界 `file.text()` / 业务读入，**不**限制平台解析峰值内存。 |
| **Next 导出/导入写出** | 构造成功 `NextResponse` 后 schedule Notify；框架把 body 写给客户端失败时 handler **观测不到**，无法像 Go `Write`/`Encode` 那样取消 Notify。 |
| **非 file part 有界 Discard** | **仅 Go** `MultipartReader` 路径；Next 无对等 per-part Discard（依赖 `formData`）。恶意超大非 file 字段在 Next 上仍可能由运行时吃满。 |

---

## 6. 与 Todo deform / Admin PATCH

| 路径 | 行为 |
|------|------|
| Query / todo 创建成功 | 待办可 deform |
| Export / Import | 仅 Record 键；deform 键 → 详细 400 |
| Admin PATCH | 拒保留 tag |
| Admin **import** | **允许**保留 tag |

---

## 7. 实现约束（已落地）

1. OpenAPI + 双端 stem（`recordjsonl` / `exportapi` / `importapi`）；错误字符串双端字节一致。  
2. 导入/导出路由 **bypass** 256KiB JSON body 门闸。  
3. 测试覆盖：游标重叠；from 400/404；limit；空导出/空导入均 Notify；事务失败无 Notify；重复 id；行级错误；保留 tag；鉴权矩阵；误接 readJsonBody 不得 413；file size 超限早退；Go 非 file part 有界丢弃。  
4. FC 64MB：有界缓冲（导出 ≤1000 行 NDJSON；导入 ≤4MiB + seen≤1000）。

---

## 8. 非目标复查

- 前端；gzip；无参全表；按 `happened_at` 切块。  
- Export JSON 信封 / X-Export 头；body suppress（已删；静音见 env）。  
- Mirror 删除未出现在文件中的行。

---

## 9. 已拍板摘要

1. Path / 鉴权 / 无 deform / Admin 可写保留 tag / 无 body suppress（静音见 env）。  
2. 导出：`from?` + `limit`∈[1,1000]；非法 from→400、不存在→404；有界组 NDJSON 下载；**写出成功后**每页 Notify（含 0 行）。  
3. 导入：multipart；≤1000 行且 file part≤4MiB 有界读入后**单事务逐行** upsert；成功才 commit+Notify（**含空文件**）；失败回滚不 Notify。  
4. 校验：表示层 Record；语义对齐 draft；跳过保留 tag 拒绝。  
5. 并发：见 §4.4 表；不夸大「LOOP 绝不丢」。

---

## 10. 待拍板

**无。**（含 2026-08-03 审查 errata。）

错误字符串终稿与模块名见各阶段落地备注。

---

## 11. 实现阶段

> 把 §7 拆成可独立 merge / 验收的阶段。**不写**逐文件实现细节。  
> **顺序理由：** 先共享「一行 Record JSONL」编解码/校验（export 写行、import 读行共用）→ 再导出 API → 再导入 API → 文档收尾。导出与导入契约不同、鉴权不同，**分阶段合入**，避免一个巨型 PR；OpenAPI **按端点随实现同 PR 落地**（禁止长期「仅有 schema、路由 501」）。

### 过渡窗口

| 窗口 | 行为 | 说明 |
|------|------|------|
| 阶段 1 已合、2/3 未合 | 仅有库函数；**无** HTTP 路径 | 可单独测行级校验；对外契约不变 |
| 阶段 2 已合、3 未合 | 仅能导出 | 合法；备份可用、恢复不可用——勿对外宣称「导入导出齐」 |
| 阶段 3 合并后 | 双 API 可用 | 可跑 round-trip；再进阶段 4 收文档 |

禁止：只合 OpenAPI 不改双端；或只合 Next 不合 Go。

---

### 阶段 1：共享 Record JSONL 行编解码 / 校验

**状态：已完成**（stem `recordjsonl`；共享 fixture `testdata/record-jsonl-cases.json`）

**目标：** 双端同构「一行 ↔ 领域行」：表示层 Record snake_case、禁止 deform 键、字段/tags 语义对齐 draft（**import 侧跳过保留 tag 拒绝**的开关可放本阶段参数，或 import 阶段再包一层——须在 stem 注释写清）。

**范围：**
- Next / Go 共享 stem（如 `recordjsonl` / 等价名）：parse 一行、serialize 一行、详细英文错误（含可选行号参数）
- 最小 fixture（合法行、非法 number 类型、tags 数组类型、deform 键、双 null 等）双端同测
- **不**挂 HTTP；**不**改 OpenAPI paths

**不做什么：**
- 不做 multipart / 游标查询 / upsert / Notify
- 不 bypass `MAX_HTTP_BODY_BYTES`
- 不写 README 大段

**验收标准：**
- [x] 双端单测覆盖 §2.1 / §2.2 表示层与语义要点（保留 tag：校验格式可通过；`assertNoReservedTags` 由调用方决定是否调用——测清边界）
- [x] 错误文案双端一致（或本阶段锁定初稿字符串表）
- [x] `npm test`（相关）与 `cd faas && go test`（相关包）绿

**依赖 / 可并行：** 无前置。阶段 2、3 依赖本阶段。

**落地备注：** `parseLine` / `ParseLine` **不**调用 `assertNoReservedTags`（包注释已写清）；语义错误复用 draft 文案（snake_case，如 `numeric_value must be a decimal string`）；表示层错误用 snake_case 缺键 / `Invalid tags` / `Invalid JSON line`。`tags` 文件格式已统一为 JSON 数组（2026-08-04 变更），import 双兼容旧字符串化数组。

---

### 阶段 2：导出 `GET /api/export/records`

**状态：已完成**（stem `exportapi`；OpenAPI `paths/export.yaml`；Next `src/app/api/export/records`；Go `handleExportRecords`）

**目标：** ApiToken；`from?` + 必填 `limit`∈[1,1000]；`LIMIT` 查询后有界组 NDJSON 下载；成功写出（含 0 行）一律 Notify；写出前错误 JSON、写出失败不 Notify。

**范围：**
- OpenAPI path + components（仅导出）+ fixtures / `openapi:lint` / `test:openapi`
- Next route + Go httpx；查询 `id ASC`；`Content-Type` / `Content-Disposition` 文件名规则 §4.3
- 使用阶段 1 serialize；鉴权矩阵；from 400 vs 404；limit 校验
- 路由 **bypass** 256KiB JSON body 门闸（本路由无 JSON body，但须确认中间件不误伤）
- 双端测试：空导出、分页重叠启发、Notify schedule（`SUPPRESS_BOT_NOTIFICATION=1` 下不实发）

**不做什么：**
- 不做 import / multipart / upsert
- 不做 gzip / 前端 / `X-Export-*` / JSON 信封
- 不改阶段 1 校验语义（除非测出 bug）

**验收标准：**
- [x] OpenAPI 与双端行为一致；未知/非法 query → 约定英文错误
- [x] 200 为 NDJSON 正文；0 行仍带正确头；**写出成功后** Notify 一次
- [x] from 非法 400、不存在 404、文案可区分
- [x] 相关契约 / httpx / route 测绿

**依赖 / 可并行：** **依赖阶段 1**。与阶段 3 **文件面可并行开发**，但建议 **先合 2 再合 3**（round-trip 与对外叙事更顺）；若并行开 PR，勿合并「仅一端导出」。

**落地备注：** 错误终稿：`Invalid record id`（400）/ `export from id not found`（404）/ `limit must be an integer between 1 and 1000`（400）；Notify：`Exported N records (from {uuid|start}, limit L)`；GET 不调用 `readJsonBody` / `readBody`；实现为有界缓冲而非 DB cursor 真 chunk 流。

---

### 阶段 3：导入 `POST /api/admin/import/records`

**状态：已完成**（stem `importapi`；OpenAPI `paths/admin.yaml` import；Next `src/app/api/admin/import/records`；Go `handleImportRecords`）

**目标：** AdminToken；multipart 字段 `file`；≤1000 行且 file part≤4MiB 有界读入后单事务逐行 upsert；可写保留 tag；成功（含空文件）commit + Notify；失败 rollback、不 Notify。

**范围：**
- OpenAPI path + schemas（导入请求/响应/错误）+ fixtures
- Next + Go：有界读 part（Next 先 `file.size`；Go `LimitReader` + 非 file part 有界 Discard）、行号、seen 查重、upsert、计数 `inserted`/`updated`/`total`
- 使用阶段 1 parse；**跳过** `assertNoReservedTags`
- **bypass** `MAX_HTTP_BODY_BYTES` / 禁止误接 `readJsonBody`（验收：大 file 不因 256KiB 门闸 413）
- 测试：超限、重复 id、行级错误、空文件 Notify、事务失败无 Notify、鉴权、保留 tag
- **Round-trip（本阶段或紧随）：** 阶段 2 已合前提下，最小「export 一行 → import」双端测（§2 要求）

**不做什么：**
- 不 mirror 删除文件中未出现的行
- 不自动插审计 / 走专用 log API 副作用
- 不做前端

**验收标准：**
- [x] 成功响应形状 §5.5；空文件全 0 + Notify
- [x] 任一行失败 → 整单 rollback + 400 含行号/字段；无 Notify
- [x] 保留 tag 可写入；Admin PATCH 行为不变（仍拒保留 tag）
- [x] openapi + 双端测绿；误接小 body 门闸的回归测存在
- [x] round-trip fixture 绿（若阶段 2 已合；否则本项 defer 到 2+3 均合后的立即补测，不得拖到阶段 4 才发现语义裂）

**依赖 / 可并行：** **依赖阶段 1**；**强依赖阶段 2 已合**才宣称 round-trip 验收完毕（实现可与 2 并行写，合入顺序建议 `2 → 3`）。

**落地备注：** 错误终稿：`import exceeds limits (max 1000 lines or 4 MiB); split the file` / `line N: duplicate record id {uuid}` / multipart 文案见 `importapi` 常量；Notify：`Imported N records (inserted I, updated U)`；HTTP 勿接 `readJsonBody` / `readBody`。

---

### 阶段 4：文档与指针收尾

**状态：已完成**

**目标：** 规格状态改为已落地；README / layering / 发展日志与终态一致；错误字符串若有润色则双端已对齐。

**范围：**
- 本篇状态行、§11 勾选
- `faas/README.md` / 根 README / `openapi/README.md` 若需提及两路径
- `docs/20260801-api-layering.md` 若有 API 面列表则补指针
- 发展日志一句

**不做什么：**
- 不夹带行为变更；发现遗漏回 1–3 修

**验收标准：**
- [x] 文档无「实现未排期」冲突句；对外路径/鉴权与 OpenAPI 一致
- [x] 本篇标记阶段 1–4 完成

**依赖 / 可并行：** **依赖阶段 1–3 均已合**。

---

### 建议落地顺序（总表）

| 顺序 | 阶段 | 可独立验收 | 依赖 | 与其它并行 |
|------|------|------------|------|------------|
| 1 | **阶段 1** 共享 JSONL 行编解码 | 是（单测） | — | 先合 |
| 2 | **阶段 2** 导出 API | 是（openapi + 双端） | 阶段 1 | 可与 3 **并行开发**；建议先合 2 |
| 3 | **阶段 3** 导入 API + round-trip | 是（openapi + 双端） | 阶段 1；（round-trip 要 2） | 同上 |
| 4 | **阶段 4** 文档收尾 | 是（审阅） | 阶段 1–3 | 不并行 |

**推荐合入节奏：** `1 → 2 → 3 → 4`。若两人并行：`1` 后 `2`∥`3` 开发，**合入仍先 2 后 3**，再立刻补 round-trip（若 3 的 PR 已含则更好）。
