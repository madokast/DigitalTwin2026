# OpenAPI 契约（已收口）

本目录是双后端 HTTP API 的**契约源**（Design-first）。OpenAPI 相关基建 **已完成并收口**：后续只随 API 变更维护本目录与契约测，**不再**加 codegen、Schemathesis、新 Phase 或其它 OpenAPI 工具链。边界见下「开发边界」。

入口始终是 [`openapi.yaml`](./openapi.yaml)；正文已按 `$ref` 拆成多文件，语义与原先单体 YAML 一致。

| 路径 | 说明 |
|------|------|
| [`openapi.yaml`](./openapi.yaml) | 根文档：`openapi` / `info` / `servers` / `tags`，以及 `paths` / `components` 的 `$ref` |
| [`paths/`](./paths/) | 按 tag 分组的 Path Item（`log` / `query` / `telegram` / `qqbot` / `db` / `admin`）；根用 JSON Pointer 引用 |
| [`components/`](./components/) | `securitySchemes` / `parameters` / `responses` / `schemas` 映射 |
| [`redocly.yaml`](./redocly.yaml) | Redocly lint 配置（`npm run openapi:lint`；Spectral 对 OAS 3.1 `type: […]` 会崩，故用 Redocly） |
| [`fixtures/`](./fixtures/) | 共享响应/请求样例；Vitest + Go `internal/contract` 共同校验 |
| `redoc-static.html`（生成物，已 gitignore） | `npm run openapi:preview` 产出的 Redoc 静态页 |

## 模块布局

```
openapi/
  openapi.yaml                 # 入口（短）
  paths/
    log.yaml                   # /api/log/number, /body/weight, /text, /transaction
    query.yaml                 # /api/query, /summary, /tags, /transaction/summary
    telegram.yaml              # /api/telegram/probe
    qqbot.yaml                 # /api/qqbot/probe
    db.yaml                    # /api/db/probe
    admin.yaml                 # /api/admin/*
  components/
    securitySchemes.yaml
    parameters.yaml
    responses.yaml
    schemas.yaml
  fixtures/
  redocly.yaml
  README.md
```

- **Path**：tag 文件顶层键为完整 path（如 `/api/log/number`）；根引用形如  
  `$ref: './paths/log.yaml#/~1api~1log~1number'`（`/` → `~1`）。
- **Components**：定义写在 `components/*.yaml`；根用**按名** `$ref`（如  
  `Error: $ref: './components/schemas.yaml#/Error'`）。kin-openapi 不支持  
  `components.schemas: $ref: './schemas.yaml'` 这种整段 map 替换。
- **跨文件引用**：子文件内不要用 `#/components/...`（Redocly / 部分解析器按**当前文件**解析 `#`）。改用相对文件指针，例如  
  `../components/schemas.yaml#/Error`；同一 `schemas.yaml` 内用 `#/TagName`。
  经根 dereference 后，契约测仍可通过 `#/components/schemas/...` 取 schema。
- 工具均从 `openapi.yaml` 加载并解析外部 `$ref`：Redocly、`@apidevtools/swagger-parser`、Go `kin-openapi`（`IsExternalRefsAllowed`）。

## 如何预览（Redoc）

```bash
npm run openapi:preview
# → openapi/redoc-static.html（浏览器打开；file:// 可用）
```

改 YAML 后需再跑一次。无常驻服务。

## 如何编辑

1. 改对应模块，而不是把逻辑塞回根文件：
   - 新/改 endpoint → `paths/<tag>.yaml`，并在根 `paths` 增加 `$ref`（JSON Pointer）。
   - 共享参数 / 响应 / schema / 鉴权方案 → `components/*.yaml`。
   - 仅改总述、servers、tags → 根 [`openapi.yaml`](./openapi.yaml)。
2. 必要时更新 [`fixtures/`](./fixtures/)。
3. 再改 Next（`src/app/api/**`、`src/lib/**`）与 Go（`faas/internal/**`），保持语义一致。
4. 跑：
   - `npm run openapi:lint`
   - `npm run test:openapi`（无 DB）
   - `cd fc && go test ./internal/contract/ -count=1`（无 DB）
   - 行为回归：`npm test` 与 `cd fc && go test ./...`
5. 用户可见的 `error` / `description` 用英文；本 README 等文档可用中文。

鉴权：`Authorization: Bearer …`；普通路由接受 AI Token 或 Admin Token；`/api/admin/*` 仅 Admin Token。

## 开发边界（定死）

### 已完成（到此为止）

| 项 | 说明 |
|----|------|
| 契约文档 | OpenAPI 3.1，多文件 `$ref`，入口 `openapi.yaml` |
| Lint / 预览 | Redocly（`openapi:lint`）、Redoc 静态页（`openapi:preview`） |
| 契约测 | `fixtures/` + Vitest Ajv + Go `internal/contract`（kin-openapi） |
| CI | `.github/workflows/ci.yml`：lint + 双端契约测 + 无 DB 单元测；`tests/api` 无 `TEST_DATABASE_URL` Skip（不 DROP）。可选 secrets `TEST_DATABASE_URL` 启用 Node 集成测 |

历史上称 Phase 1（文档）/ Phase 2（lint + 契约测 + CI）。**不设 Phase 3，不再开 OpenAPI「下一阶段」。**

### 后续开发只做这些

改 API 时（且仅在此时）碰本目录：

1. 更新 YAML 模块 + 根 `$ref`（见「如何编辑」）。
2. 必要时增改 `fixtures/`。
3. 手写对齐 Next（`src/app/api/**`、`src/lib/**`）与 Go（`faas/internal/**`）。
4. 跑：`openapi:lint`、`test:openapi`、`go test ./internal/contract/`，以及行为测 `npm test` / `cd fc && go test ./...`。

契约测继续锁**请求/响应形状**；**业务语义**靠双端手写 + 行为/集成测，不靠生成或模糊轰炸。

### 明确不做（不要再提案）

| 不做 | 原因（摘要） |
|------|----------------|
| **Codegen**（TS types / Go structs / server stub / 客户端 SDK） | 形状已由契约测覆盖；codegen 锁不住双端语义；与 App Router + 手写 FC 不合，只增生成流水线税 |
| **Schemathesis**（及同类：对真实 HTTP 按 spec 全路径模糊 / 属性测试） | 需起服务 + 测试库 + Token；CI 更重；与现有 fixtures + 行为测叠床架屋；个人小 API 面税大于收益 |
| 新 OpenAPI Phase / 额外契约工具链（Spectral 主链路、其它生成器、契约「平台化」等） | 基建已够用；避免夜长梦多 |

若某次改 API 只需补 fixture 或收紧 `pattern`，那是**维护**，不是新阶段。

## Schema 硬约束（pattern）

| Schema | 规则 |
|--------|------|
| `HappenedAtInput` | ISO 日期时间 + 必填时区后缀 `Z` / `±HH:MM` / `±HHMM` |
| `HappenedAtUtcZ` | 输出专用：`…sssZ` |
| `DecimalString` | `^-?(?:0\|[1-9]\d*)(?:\.\d+)?$`，`maxLength` 40 |
| `MoneyAmountString` | `^-?(?:0\|[1-9]\d{0,11})(?:\.\d{1,2})?$`；运行时拒零；绝对值 ≤ `999999999999.99`；禁 trim / `+`；通过后规范为两位小数入库；交易 `entries[].amount` |
| `WeightAmountString` | `^(?:0\|[1-9]\d{0,2})(?:\.\d{1,2})?$`；运行时限 **1.00–500.00**（kg）；禁 trim / `+` / 负号；JSON number → 400；通过后规范为两位小数；`LogBodyWeightRequest.value_number` |
| `TagName` | 标识符 + 可选 `:` 分段 |

`Record.valueNumber` / `LogNumberRequest.value_number` / PATCH draft 等均 `$ref` 上述组件（nullable 用 `oneOf`）。

## 已对齐约定（摘要）

| 项 | 规则 |
|----|------|
| `happened_at` / query `from`/`to` | 一律带时区；裸日期 → 400 |
| `Record.happenedAt` 输出 | UTC `…sssZ` |
| `Record.valueNumber` | 仅十进制字符串 / null；JSON **number → 400**；字面量入库 |

## 契约测覆盖

Fixtures 覆盖：RecordSuccess（number/text）、Error、Query/Summary/TagsSuccess、LogNumber/LogBodyWeight/LogText 请求、Rename 请求/成功、RecordDraft、Telegram probe 请求/成功、LogTransaction（含 `type`）；非法：JSON number、`1e3`、无时区 `happened_at`、transaction 缺 `type` / 空 entries。

存量：若库中仍有裸 tag `transaction_entry`（无 `:type` 后缀），测试/生产库需手工 truncate/清理；契约与测试已按前缀语义对齐。保留前缀另含 `body:weight`（专用 `POST /api/log/body/weight`）。

Telegram **实发**在测试模式（`DIGITAL_TWIN_TEST`）下由 notify 路径跳过；probe 单测用 mock。
