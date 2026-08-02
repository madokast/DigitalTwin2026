<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 语言原则

- **用户可见文案一律英文**：前端展示、错误信息、日志、脚本 stdout/stderr、API `error` 字段、aria-label、placeholder 等。
- **仅代码注释与文档用中文**（含 `*.md`、代码 `//` / `/* */` / `#` 注释）。
- 测试数据里故意使用的非 ASCII（如非法 tag 样例）除外；断言文案须与英文运行时消息一致。

# Neon / 数据库

- **生产代码**：只用标准 PostgreSQL，不依赖 Neon 特色（branching、serverless driver 等），便于日后切国内云数据库。
- **测试环境**：可用独立测试库或 Neon 临时能力跑测，测完不污染主库。
- Next（Vercel）与国内 FaaS **共用同一套库**：test 对测试库，prod 对生产库（与 Vercel 生产 `DATABASE_URL` 相同）。

# 双后端（必须同时维护）

本仓库有两套 HTTP API 实现，**路径 / 鉴权 / 语义必须一致**：

| | Next（默认 / 海外） | Go FaaS（国内加速） |
|--|-------------------|-------------------|
| 代码 | `src/app/api`、`src/lib` | [`faas/`](faas/)（`cmd/` + `internal/`） |
| 部署 | Vercel | 阿里云 FC：[`faas/providers/aliyun-fc/`](faas/providers/aliyun-fc/)（多云布局见 [`docs/20260802-faas-multi-cloud.md`](docs/20260802-faas-multi-cloud.md)） |
| 详情 | 根 [`README.md`](README.md) | **[`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)**（测试、部署、安全一条龙）；共享说明 [`faas/README.md`](faas/README.md) |

- **分层与同构**：共享后端域须双端模块 / 函数 stem 对齐；规范见 [`docs/20260801-api-layering.md`](docs/20260801-api-layering.md)。
- **API 契约**：入口 [`openapi/openapi.yaml`](openapi/openapi.yaml)（OpenAPI 3.1，`$ref` 拆至 `openapi/paths/`、`openapi/components/`；说明见 [`openapi/README.md`](openapi/README.md)）。基建已收口；**不做** codegen / Schemathesis / 新 OpenAPI Phase。本地浏览：`npm run openapi:preview`（Redoc 静态 HTML）。
- **改 API = 更新 OpenAPI（+ fixtures）+ 双改代码 + 双跑测试**：`npm run openapi:lint`（Redocly）、`npm run test:openapi`、`cd faas && go test ./internal/contract/`，以及 `npm test` / `cd faas && go test ./...`。CI：[`.github/workflows/ci.yml`](.github/workflows/ci.yml)（lint + 契约 + 无 DB 单元测；Node `tests/api` 无 `TEST_DATABASE_URL` 时 Skip，且不 DROP schema；Go httptest 集成无 `DATABASE_URL` 时 Skip。可选 secrets `TEST_DATABASE_URL` 等启用 Node 集成测 job）。
- 网页 Settings 中的 **API Accelerate URL** 指向国内 FaaS Base URL（当前为 FC；日后亦可为 SCF）；空则同源 Vercel。真实 URL **禁止进 git**。
- 部署：`npm run deploy -- test|prod` — `test` 跳过 Vercel、可选 FC/SCF；`prod` 先问 Vercel / FC / SCF（均 `[y/N]` **默认 N**），任一 Y 才 `collect-prod-env` → 临时 `.env.prod` 再分发；细节见 [`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md) 与 [`docs/20260802-faas-multi-cloud.md`](docs/20260802-faas-multi-cloud.md) §4。
- **共享 Go 不得** import `faas/providers/*`。

# 部署原则（摘要）

- Vercel：海外主站；国内 API 加速：阿里云 FC（`faas/providers/aliyun-fc`）；腾讯云 SCF 为规划中的可选 provider。
- API 保持标准 HTTP，便于移植。
- FC 操作、`s deploy` 禁令、密钥文件、省钱规格等：**只维护在 [`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)**，此处不重复步骤。
