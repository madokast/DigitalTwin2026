<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 语言原则

- **用户可见文案一律英文**：前端展示、错误信息、日志、脚本 stdout/stderr、API `error` 字段、aria-label、placeholder 等。
- **仅代码注释与文档用中文**（含 `*.md`、代码 `//` / `/* */` / `#` 注释）。
- 测试数据里故意使用的非 ASCII（如非法 tag 样例）除外；断言文案须与英文运行时消息一致。

# HTTP JSON / JSONL 键名（强制 snake_case）

- **所有对外 HTTP JSON 与 JSONL 的键名一律 `snake_case`，无一例外**（请求体、响应体、success 包络、OpenAPI schema/fixtures、import/export JSONL）。
- **禁止**再引入 camelCase JSON 键（例如不得出现 `happenedAt`、`numericValue`、`pageSize`、`databaseReachable`）。
- 示例（Record）：`happened_at`、`numeric_value`、`raw_content`、`objective_context`、`subjective_interpretation`；包络示例：`page_size`；探测示例：`database_reachable`、`connect_ms`。
- 内部 TS/Go **变量名、Drizzle 属性、struct 字段名**可仍用惯用 camelCase / PascalCase；**仅序列化到 JSON/JSONL 的键**必须 snake。Go 用 `json:"happened_at"`；TS 组装响应对象时用 snake 键字面量（或显式 serializer），禁止 `JSON.stringify` 直接 dump Drizzle 行导致驼峰漏网。
- 查询串参数与 JSON 键对齐时也用 snake（如 `page_size`）；错误文案里的字段名与契约键一致。

# 复盘 API（暂停）

- **`POST /api/log/review`（复盘）暂停实现**——不要落地该路由或相关 OpenAPI/代码。
- 若对话草稿或未提交文档仍有 review 规格，**不要继续写代码**；待 JSON 蛇形统一后再议。

# 数据库

- **只用标准 PostgreSQL**：不依赖任何托管商特色（Neon branching、serverless driver 等），便于日后切国内云数据库或内网实例。
- **测试环境**：独立测试库，可用任意 PG 实例（内网 / 本地 / Neon 等），测完不污染主库。
- Next（Vercel）与国内 FaaS **共用同一套库**：test 对测试库，prod 对生产库（与 Vercel 生产 `DATABASE_URL` 相同）。
- **`happened_at` 读出区**：隐列 `utc_offset`（对外 JSON 不可见）— 见 [`docs/20260803-utc-offset.md`](docs/20260803-utc-offset.md)。Schema 加列：**改基准 `0000` / Drizzle schema 后 drop 重建**；**禁止**增量 `ADD COLUMN` migration。

# 双后端（必须同时维护）

本仓库有两套 HTTP API 实现，**路径 / 鉴权 / 语义必须一致**：

| | Next（默认 / 海外） | Go FaaS（国内加速） |
|--|-------------------|-------------------|
| 代码 | `src/app/api`、`src/lib` | [`faas/`](faas/)（`cmd/` + `internal/`） |
| 部署 | Vercel | 阿里云 FC：[`faas/providers/aliyun-fc/`](faas/providers/aliyun-fc/)；腾讯云 SCF：[`faas/providers/tencent-scf/`](faas/providers/tencent-scf/)（多云见 [`docs/20260802-faas-multi-cloud.md`](docs/20260802-faas-multi-cloud.md)） |
| 详情 | 根 [`README.md`](README.md) | FC：**[`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)**；SCF：**[`faas/providers/tencent-scf/README.md`](faas/providers/tencent-scf/README.md)**；共享说明 [`faas/README.md`](faas/README.md) |

- **分层与同构**：共享后端域须双端模块 / 函数 stem 对齐；规范见 [`docs/20260801-api-layering.md`](docs/20260801-api-layering.md)。
- **API 契约**：入口 [`openapi/openapi.yaml`](openapi/openapi.yaml)（OpenAPI 3.1，`$ref` 拆至 `openapi/paths/`、`openapi/components/`；说明见 [`openapi/README.md`](openapi/README.md)）。基建已收口；**不做** codegen / Schemathesis / 新 OpenAPI Phase。本地浏览：`npm run openapi:preview`（Redoc 静态 HTML）。
- **改 API = 更新 OpenAPI（+ fixtures）+ 双改代码 + 双跑测试**：`npm run openapi:lint`（Redocly）、`npm run test:unit`（无 DB 单元 + 契约）、`npm run test:integration`（双端 API 集成；.env.test 无合法 `DATABASE_URL` 时报错；跑测前自动重建测试库表结构）。测试命令与门闸语义见 README「测试」；Go 集成测自动加载仓库根 `.env.test`（同 Node `tests/setup.ts`，`go test -short` 为纯单元测）。CI：[`.github/workflows/ci.yml`](.github/workflows/ci.yml)（lint + 契约 + 无 DB 单元测；Node `tests/api` / Go httptest 集成在无安全 `DATABASE_URL`（host/库名含 `test` 或 `TestDigitalTwin`）时 Skip；unsafe 则拒绝。CI 检出不含 `.env.test`，Go 集成自动 Skip。可选 secrets `DATABASE_URL` 等启用 Node 集成测 job）。
- 网页 Settings 中的 **API Accelerate URL** 指向任一国内 FaaS Base URL（阿里云 FC 或腾讯云 SCF）；空则同源 Vercel。真实 URL **禁止进 git**。
- 部署：`npm run deploy -- test|prod` — `test` 跳过 Vercel、可选 FC/SCF；`prod` 先问 Vercel / FC / SCF（均 `[y/N]` **默认 N**），任一 Y 才 `collect-prod-env`（DB 校验后可选 migrate）→ 临时 `.env.prod` 再仅部署所选；细节见 [`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)、[`faas/providers/tencent-scf/README.md`](faas/providers/tencent-scf/README.md) 与 [`docs/20260802-faas-multi-cloud.md`](docs/20260802-faas-multi-cloud.md) §4。
- **共享 Go 不得** import `faas/providers/*`。

# 部署原则（摘要）

- Vercel：海外主站；国内 API 加速：**永久双云** — 阿里云 FC（`faas/providers/aliyun-fc`）与腾讯云 SCF Web（`faas/providers/tencent-scf`，runtime **Go1** + `scf_bootstrap`）；客户端只粘贴一条 Accelerate URL。
- API 保持标准 HTTP，便于移植。
- FC 操作、`s deploy` 禁令、密钥文件、省钱规格等：**只维护在 [`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)**；SCF 登录 / Go1 打包 / CLI 透传：**只维护在 [`faas/providers/tencent-scf/README.md`](faas/providers/tencent-scf/README.md)**，此处不重复步骤。
