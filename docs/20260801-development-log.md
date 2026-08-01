# DigitalTwin2026 开发日志

> 日期：2026-08-01
> 状态：已落地并推送 — `POST /api/log/transaction`（整单 `type` + 命名空间前缀保留 tag）；summary 延期

## 0. 今日做成了什么（总览）

| 类别 | 已完成 |
|------|--------|
| Transaction 写入 | `POST /api/log/transaction`：batch `entries`、共用 `happened_at`、响应仅 `{ success, inserted }` |
| type | 顶层必填 `income` \| `expense`（整单共享；混用则调两次 API） |
| 落库 tags | `["transaction_entry:{type}","{category}:{subcategory}"]` |
| amount | 十进制字符串；**零 → 400**；正=正常、负=该 type 冲销 |
| 保留 tag | 前缀语义：`P` 或 `P:…`（首批 `P=transaction_entry`）；number/text/Admin draft/rename 拒绝 |
| 双端 | Next + Go FC；OpenAPI + fixtures + 契约测 / 路由测 |
| 文档 | 本日志；`openapi/README` 注明存量裸 tag 需清库 |
| 明确不做 / 延期 | transaction **summary**、Dashboard、网页录入 UI |

另：同日早先完成的 OpenAPI 收口（codegen/Schemathesis 不做）已在 `c862052` 合入。

## 1. 契约摘要

| 项 | 约定 |
|----|------|
| 路径 | `POST /api/log/transaction`（ApiToken） |
| Body | `happened_at` + `type` + `entries[]`（`amount` / `memo` / `category` / `subcategory`） |
| entries | 长度 1..100；空数组 400 |
| amount | DecimalString；`0` / `0.0` / `-0` → 400（`entries[i]: amount must not be zero`） |
| 落库 | `value_number`←amount；`objective_context`←memo；`value_text` / `subjective_interpretation` = null |
| 保留 tag | `tag === P \|\| tag.startsWith(P + ":")`；**不是**无冒号边界的裸 `startsWith(P)`（避免误伤 `transaction_entrypoint`） |
| 感受/评价 | 另走 `POST /api/log/text` |
| 破坏性 | 相对首版裸 `transaction_entry` 为破坏性变更；预生产，无 API 版本号 |

符号语义：

| type | amount | 含义 |
|------|--------|------|
| income | `> 0` | 收入 |
| income | `< 0` | 收入冲销 |
| expense | `> 0` | 支出 |
| expense | `< 0` | 支出冲销 |

## 2. 实现落点

- Next：`src/lib/transaction-draft.ts`、`src/app/api/log/transaction/route.ts`；`src/lib/tags.ts`；Telegram 整单摘要含 `type`
- Go：`fc/internal/logapi/transaction.go`；httpx 注册；tags / draft / rename 护栏；telegram 摘要
- OpenAPI：`TransactionType`、`LogTransactionRequest`、`TransactionBatchSuccess`；fixtures（含 missing-type / zero 相关）
- 测：契约、单元、路由级 reserved（number/text/rename/PATCH）、Go 对等测

## 3. 验证

- `npm run openapi:lint` — pass
- `npm run test:openapi` — pass
- vitest：tags / transaction-draft / record-draft / routes — pass
- `cd fc && go test ./internal/{tags,logapi,contract,draft,httpx,telegram}` — pass

## 4. 存量清库

若测试/生产库仍有**裸** tag `transaction_entry`（无 `:income` / `:expense`）的行，请手工 truncate/清理。本变更不附带自动 wipe（集成测本身会 truncate 测试表）。

## 5. 今日提交（节选）

```
2f3850b 为 transaction 增加 type，并将保留 tag 改为命名空间前缀语义。
27d20f4 添加 POST /api/log/transaction 批量收支录入，并引入保留 tag。
c862052 收口 OpenAPI：定死开发边界，明确不做 codegen 与 Schemathesis。
```

（本日志补记提交见后续 commit。）

## 6. 仍待办

- [ ] `GET /api/query/transaction/summary`（按 `transaction_entry:income|expense` + 符号聚合；**已延期**，勿用「正=支出」旧草案）
- [ ] Dashboard 支出组件
- [ ] 记录删除 / 图表 / 列表行内编辑
- [ ] 体重等其它专用 log、AI CLI、数据导出
