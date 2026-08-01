# DigitalTwin2026 开发日志

> 日期：2026-08-01
> 状态：已落地 — `POST /api/log/transaction`（顶层 `type` + 前缀保留 tag）

## 0. 今日目标

承接 0731 待办：账单/收支录入。专用 `**POST /api/log/transaction**`（路径用 transaction，便于 AI 识别）。仅 batch：`entries` 长度 ≥1；共用 `happened_at` + **`type`**；响应 `{ success, inserted }`。

## 1. 契约摘要


| 项       | 约定                                                                                           |
| ------- | -------------------------------------------------------------------------------------------- |
| 路径      | `POST /api/log/transaction`                                                                  |
| Body    | `happened_at` + **`type`**（`income`\|`expense`，整单共享）+ `entries[]`（`amount`/`memo`/`category`/`subcategory`） |
| amount  | 经 decimal 校验后为零 → 400（`amount must not be zero`）；正=正常、负=该 `type` 的冲销                         |
| 落库 tags | `["transaction_entry:{type}","{category}:{subcategory}"]`                                    |
| 落库其它    | `value_number`←amount；`objective_context`←memo；`value_text`/`subjective_interpretation`=null |
| 保留 tag  | **前缀** `transaction_entry`：`tag===P \|\| tag.startsWith(P+":")`；number/text/Admin draft/rename 拒绝 |
| 感受/评价   | 另走 `POST /api/log/text`                                                                      |
| 不做      | transaction summary、Dashboard、网页录入 UI                                                        |


## 2. 实现落点

- Next：`src/lib/transaction-draft.ts`、`src/app/api/log/transaction/route.ts`；`tags.ts` 前缀保留；Telegram 整单摘要含 `type`
- Go：`fc/internal/logapi/transaction.go` + httpx 注册；tags/draft/rename 护栏
- OpenAPI：`paths/log.yaml` + schemas（`TransactionType`）+ fixtures；契约测扩展

## 3. 验证

- `npm run openapi:lint` / `npm run test:openapi`
- `vitest` tags / transaction-draft / record-draft / routes
- `cd fc && go test ./internal/{tags,logapi,contract,draft,httpx,telegram}`

## 4. 存量清库

若测试/生产库中仍有**裸** tag `transaction_entry`（无 `:income`/`:expense` 后缀）的行，请手工 truncate/清理；本变更不附带自动 wipe 脚本（测试库本身已 truncate）。

## 5. 仍待办

- [ ] `GET` 账单/transaction 汇总（summary）— **本任务明确延期**
- [ ] Dashboard 支出组件
- [ ] 记录删除 / 图表等
