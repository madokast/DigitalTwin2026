# DigitalTwin2026：双后端（Next / Go FaaS）API 一致性审计与差异清单

> 创建日期：2026-08-03  
> 状态：**部分修复**（D1 已于 2026-08-04 修复；其余差异未修复）  
> 性质：audit 记录；修复前必读，改动双端时对照本清单逐一收敛

> 相关：[`docs/20260801-api-layering.md`](20260801-api-layering.md)（分层同构规范）、[`AGENTS.md`](../AGENTS.md)（双后端必须同时维护）、[`openapi/openapi.yaml`](../openapi/openapi.yaml)（契约基准）

---

## 0. 一句话结论

**鉴权与正常业务路径双端完全一致；非法输入边界的错误行为存在分叉**，最严重的是 probe 畸形 JSON 的**状态码级分歧**（Next 200/502 vs Go 400，且 Next 会静默真发消息）。该差异（D1）已于 2026-08-04 修复（契约改为：空 body 允许走默认文案、非空畸形 JSON → 400，双端对齐）；其余差异仍存在。

---

## 1. 审计方法（2026-08-03）

1. **自动化测试全绿**（基线）：

   | 套件 | 结果 |
   |------|------|
   | `npm run test:openapi`（契约 fixtures） | 15 passed |
   | `cd faas && go test ./internal/contract/` | ok |
   | `npm test`（Node 单测） | 534 passed |
   | `cd faas && go test ./...`（含无 DB 单元测） | 全 ok |
   | `npm run test:integration`（双端 API 集成，真实测试库） | Node 95 + Go httpx/dbprobe 全过 |

2. **代码逐端点对比**（17 个端点 × Next/Go）：鉴权、成功包络、主要错误路径逐字节比对。

3. **实测复现**（本次新增证据）：
   - Go：`go build` 到 /tmp 后起 `:9099` 连测试库，curl 发边界输入。
   - Next：`tsx` 内联直接调 route handler（`new NextRequest` 构造请求）。
   - 安全措施：Telegram 用**假 token** 覆盖环境变量防真实投递；合法用例插入的 `dtv:verify` marker 记录已删除；审计后仓库 `git status` 零改动。

---

## 2. 实测复现的差异（同输入，双端不同响应）

### D1（高）~~probe 畸形 JSON：状态码分歧 + Next 会真发消息~~ **已修复（2026-08-04）**

| | Next | Go |
|--|------|-----|
| 输入 | `POST /api/telegram/probe`（或 `/api/qqbot/probe`）body 为 `{broken` 等畸形 JSON | 同左 |
| 修复前 | **502** `{"error":"Telegram sendMessage failed: Not Found"}`（假 token）；真 token 下为 **200** 且**静默发送默认文案消息** | **400** `{"error":"Invalid JSON body"}`，**不发消息** |
| 修复后 | **400** `{"error":"Invalid JSON body"}`，**不发消息**（与 Go 一致） | 不变 |
| 位置 | 修复于 `src/app/api/telegram/probe/route.ts`、`src/app/api/qqbot/probe/route.ts`（`JSON.parse` 失败改为返回 400，不再被 `catch {}` 吞掉）；空 body 仍允许走默认文案 | `faas/internal/httpx/server.go:385-388`、`420-423`（`RejectUnknownObjectKeys` 先失败） |

契约同步：`openapi/paths/telegram.yaml`、`openapi/paths/qqbot.yaml` 原描述「non-JSON body is allowed」实为钉死 Next 的错误行为；已改为「空 body 允许走默认文案；非空 body 须为 JSON object，畸形 JSON → 400」。Go 行为本就符合新契约。双端测试：`tests/api/probe.test.ts`（Node）、`faas/internal/httpx/server_test.go`（Go，含 bot API 零调用断言）。

### D2（中）JSON 写路径顶层 `null`：错误文案分叉（同为 400）

| | Next | Go |
|--|------|-----|
| 输入 | `POST /api/log/number` body 为 `null` | 同左 |
| 实测 | **400** `{"error":"Missing required field: happened_at"}`（`null` 被归一为 `{}` 继续字段校验） | **400** `{"error":"Request body must be a JSON object"}` |
| 位置 | `src/lib/httpjson.ts:44-47` | `faas/internal/jsonutil/decode.go:43-46`（写路径各 handler 第一步） |

根因：`httpjson.ts:44` 注释假设「Go 对 `null` unmarshal 为零值不报错」；但 Go 在 struct 解码前先跑 map 型 `RejectUnknownObjectKeys`，假设不成立——**双端互相参照时留下的盲区**。影响全部 JSON 写路径（`/api/log/*`、`/api/admin/tags/rename`、`PATCH /api/admin/records/{id}`、todo transition）。

### D2'（中）JSON 写路径顶层数组 / 字面量：文案分叉（同为 400）

| | Next | Go |
|--|------|-----|
| 输入 | `POST /api/log/number` body 为 `[]` | 同左 |
| 实测 | **400** `{"error":"Invalid JSON body"}` | **400** `{"error":"Request body must be a JSON object"}` |
| 位置 | `src/lib/httpjson.ts:48-50` | 同 D2 |

---

## 3. 代码层面差异（未逐一实测；同为低优先边界）

| # | 严重度 | 场景 | Next | Go | 位置 |
|---|--------|------|------|-----|------|
| D3 | 低-中 | import multipart 缺 boundary | **500** `Internal server error`（formData 抛错落 catch） | **400** `ErrMultipartContentType` | `src/app/api/admin/import/records/route.ts:32,95-100` vs `faas/internal/httpx/server.go:666-670` |
| D4 | 低 | import 非 file part 超 4MiB | 无 per-part 上限（可能 200） | **400** `ErrMultipartPartTooLarge` | route.ts vs server.go:690-699 |
| D5 | 低 | import 文本 part 名为 `file` | 400 `multipart form field "file" is required` | 400 `Invalid JSON line`（文案不同） | route.ts:48-53 vs server.go:722-725 |
| D6 | 低 | transaction summary 脏数据金额字面量 | 严格正则，不匹配**跳过该行** | `big.Rat.SetString` 接受前导零 / 科学计数，**计入聚合** | `src/lib/query.ts:334-348` vs `faas/internal/query/query.go:597-600`（正常写入路径不产生此类数据） |
| D7 | 低 | todo transition UPDATE 影响行数 | 不校验（SELECT 与 UPDATE 间记录被删仍 200 + 插审计行） | `RowsAffected() != 1` → **500** | `src/lib/logapi.ts:314-329` vs `faas/internal/logapi/todo.go:176-178`（并发竞态） |
| D8 | 低 | db/probe 连接超时 | `connect_timeout: 15` | 无显式 ConnectTimeout | `src/lib/dbprobe.ts:49-53` vs `faas/internal/dbprobe/dbprobe.go:44`（不可达 DB 时等待时长不同） |

---

## 4. 已文档化的允许差异（非缺口）

见 [`docs/20260801-api-layering.md`](20260801-api-layering.md) §1.1：

- OPTIONS/CORS：Next 无 CORS 头且 OPTIONS 走鉴权 401；Go 外层 `withCORS` 对 OPTIONS 204 且所有响应带头。
- 404/405 形态：Next 框架默认；Go 统一 `{"error":"Not found"}` / `{"error":"Method not allowed"}` + Allow。
- notify 调度：Next `after()` vs Go `go` 协程。
- UTF-16 vs rune 长度计数（仅影响会被正则先拒的非 ASCII 非法字面量）。

---

## 5. 后续修复建议（未实施）

1. **D1（已完成，2026-08-04）**：Next probe 将 `JSON.parse` 失败（含尾部垃圾）改为 400 `Invalid JSON body`（对齐 Go 的 `RejectUnknownObjectKeys` 流程），避免静默真发消息；契约同步至 OpenAPI，双端加测试。
2. **D2/D2'**：统一 `httpjson.ts` 对顶层 `null`/数组/字面量的处理为 Go 的 `Request body must be a JSON object`（400），并修正 `httpjson.ts:44` 的错误注释。
3. **D3–D5**：import 边界对齐（缺 boundary → 400、per-part 上限、文本 file part 文案统一）。
4. **D6–D8**：视需要对齐（脏数据解析、并发竞态校验、连接超时）。
5. 每项修复需同步更新 OpenAPI fixtures（如契约钉死这些边界）并双端加测试。

---

## 6. 附：本次实测命令摘录

```bash
# Go 端（连测试库 :9099）
go build -o /tmp/opencode/goapi ./cmd/api
setsid env PORT=9099 /tmp/opencode/goapi &   # 脱离会话，防超时连带杀掉
curl -X POST http://localhost:9099/api/telegram/probe -H "Authorization: Bearer $DIGITAL_TWIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{broken'   # → 400 Invalid JSON body
curl -X POST http://localhost:9099/api/log/number -H "Authorization: Bearer $DIGITAL_TWIN_TOKEN" \
  -H 'Content-Type: application/json' -d 'null'      # → 400 Request body must be a JSON object
curl -X POST http://localhost:9099/api/log/number -H "Authorization: Bearer $DIGITAL_TWIN_TOKEN" \
  -H 'Content-Type: application/json' -d '[]'        # → 400 Request body must be a JSON object

# Next 端（tsx 内联调 route handler；注意 tsx -e 按 CJS 执行，顶层 await 需包 async IIFE）
set -a; source .env.test; set +a
TELEGRAM_BOT_TOKEN='invalid-token-for-test' npx tsx -e "..."
# probe 畸形 JSON → 502 Telegram sendMessage failed（真 token 时为 200 并真发消息）
# log/number null → 400 Missing required field: happened_at
# log/number []   → 400 Invalid JSON body
```

> 注意：`source` 不自动 export，审计时变量未导出曾导致 probe 行为假象（200 vs 400 反复横跳）；务必 `set -a` 后再 source。
