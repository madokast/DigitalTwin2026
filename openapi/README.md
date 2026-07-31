# OpenAPI 契约（Phase 2）

本目录是双后端 HTTP API 的**契约源**（Design-first，**无** TypeScript / Go codegen）。

| 文件 | 说明 |
|------|------|
| [`openapi.yaml`](./openapi.yaml) | OpenAPI 3.1；路径 / 鉴权 / 请求响应与 Next + Go 实现对齐 |
| [`redocly.yaml`](./redocly.yaml) | Redocly lint 配置（`npm run openapi:lint`；Spectral 对 OAS 3.1 `type: […]` 会崩，故用 Redocly） |
| [`fixtures/`](./fixtures/) | 共享响应/请求样例；Vitest + Go `internal/contract` 共同校验 |
| `redoc-static.html`（生成物，已 gitignore） | `npm run openapi:preview` 产出的 Redoc 静态页 |

## 如何预览（Redoc）

```bash
npm run openapi:preview
# → openapi/redoc-static.html（浏览器打开；file:// 可用）
```

改 YAML 后需再跑一次。无常驻服务。

## 如何编辑

1. 先改 [`openapi.yaml`](./openapi.yaml)（或与实现同步时两边一起改）。
2. 必要时更新 [`fixtures/`](./fixtures/)。
3. 再改 Next（`src/app/api/**`、`src/lib/**`）与 Go（`fc/internal/**`），保持语义一致。
4. 跑：
   - `npm run openapi:lint`
   - `npm run test:openapi`（无 DB）
   - `cd fc && go test ./internal/contract/ -count=1`（无 DB）
   - 行为回归：`npm test` 与 `cd fc && go test ./...`
5. 用户可见的 `error` / `description` 用英文；本 README 等文档可用中文。

鉴权：`Authorization: Bearer …`；普通路由接受 AI Token 或 Admin Token；`/api/admin/*` 仅 Admin Token。

## 阶段状态

- **Phase 1**：契约文档已落地；**无** codegen。
- **Phase 2**：Redocly lint + fixture 契约测（Node Ajv / Go kin-openapi）+ GitHub Actions CI（不含需 DB 的集成测）。
- **浏览**：`npm run openapi:preview`。
- **明确不做（暂）**：对真实 HTTP 跑 [Schemathesis](https://schemathesis.readthedocs.io/)（或同类）全路径模糊测试。当前靠静态 fixtures + 双端行为测；若日后要端到端契约轰炸再开，不在本仓库默认流程里。

改 API = 更新 YAML + fixtures（如有）+ 两套实现 + 双跑测试 / 契约测。

## Schema 硬约束（pattern）

| Schema | 规则 |
|--------|------|
| `HappenedAtInput` | ISO 日期时间 + 必填时区后缀 `Z` / `±HH:MM` / `±HHMM` |
| `HappenedAtUtcZ` | 输出专用：`…sssZ` |
| `DecimalString` | `^-?(?:0\|[1-9]\d*)(?:\.\d+)?$`，`maxLength` 40 |
| `TagName` | 标识符 + 可选 `:` 分段 |

`Record.valueNumber` / `LogNumberRequest.value_number` / PATCH draft 等均 `$ref` 上述组件（nullable 用 `oneOf`）。

## 已对齐约定（摘要）

| 项 | 规则 |
|----|------|
| `happened_at` / query `from`/`to` | 一律带时区；裸日期 → 400 |
| `Record.happenedAt` 输出 | UTC `…sssZ` |
| `Record.valueNumber` | 仅十进制字符串 / null；JSON **number → 400**；字面量入库 |

## 契约测覆盖

Fixtures 覆盖：RecordSuccess（number/text）、Error、Query/Summary/TagsSuccess、LogNumber/LogText 请求、Rename 请求/成功、RecordDraft、Telegram probe 请求/成功；非法：JSON number、`1e3`、无时区 `happened_at`。

Telegram **实发**在测试模式（`DIGITAL_TWIN_TEST`）下由 notify 路径跳过；probe 单测用 mock。
