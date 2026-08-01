# DigitalTwin2026 开发日志

> 日期：2026-08-01
> 状态：已落地 — `POST /api/log/transaction` batch + 保留 tag `transaction_entry`

## 0. 今日目标

承接 0731 待办：账单/收支录入。专用 **`POST /api/log/transaction`**（路径用 transaction，便于 AI 识别）。仅 batch：`entries` 长度 ≥1；共用 `happened_at`；响应 `{ success, inserted }`。

## 1. 契约摘要

| 项 | 约定 |
|----|------|
| 路径 | `POST /api/log/transaction` |
| Body | `happened_at` + `entries[]`（`amount`/`memo`/`category`/`subcategory`） |
| 落库 tags | `["transaction_entry","{category}:{subcategory}"]` |
| 落库其它 | `value_number`←amount；`objective_context`←memo；`value_text`/`subjective_interpretation`=null |
| 保留 tag | `transaction_entry`：仅本 API 服务端写入；number/text/Admin draft/rename 拒绝 |
| 感受/评价 | 另走 `POST /api/log/text` |
| 不做 | transaction summary、Dashboard、网页录入 UI |

## 2. 实现落点

- Next：`src/lib/transaction-draft.ts`、`src/app/api/log/transaction/route.ts`；`tags.ts` 保留 tag；Telegram 整单摘要
- Go：`fc/internal/logapi/transaction.go` + httpx 注册；tags/draft/rename 护栏
- OpenAPI：`paths/log.yaml` + schemas + fixtures；契约测扩展

## 3. 验证

- `npm run openapi:lint` — pass
- `npm run test:openapi` — 10 pass
- `vitest` tags / transaction-draft / record-draft — pass
- `vitest tests/api/routes.test.ts` — reserved guards：log/text、log/number、admin rename、admin PATCH；transaction batch
- `cd fc && go test ./internal/{tags,logapi,contract,draft,httpx}` — pass（含 CreateText / httpx rename+text reserved）

## 4. 仍待办

- [ ] `GET` 账单/transaction 汇总（summary）
- [ ] Dashboard 支出组件
- [ ] 记录删除 / 图表等
