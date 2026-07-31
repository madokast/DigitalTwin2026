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
- Next（Vercel）与 FC **共用同一套库**：test 对测试库，prod 对生产库（与 Vercel 生产 `DATABASE_URL` 相同）。

# 双后端（必须同时维护）

本仓库有两套 HTTP API 实现，**路径 / 鉴权 / 语义必须一致**：

| | Next（默认 / 海外） | Go FC（国内加速） |
|--|-------------------|-------------------|
| 代码 | `src/app/api`、`src/lib` | [`fc/`](fc/) |
| 部署 | Vercel | 阿里云函数计算 |
| 详情 | 根 [`README.md`](README.md) | **[`fc/README.md`](fc/README.md)**（测试、部署、安全一条龙） |

- **API 契约**：入口 [`openapi/openapi.yaml`](openapi/openapi.yaml)（OpenAPI 3.1，`$ref` 拆至 `openapi/paths/`、`openapi/components/`；说明见 [`openapi/README.md`](openapi/README.md)）。基建已收口；**不做** codegen / Schemathesis / 新 OpenAPI Phase。本地浏览：`npm run openapi:preview`（Redoc 静态 HTML）。
- **改 API = 更新 OpenAPI（+ fixtures）+ 双改代码 + 双跑测试**：`npm run openapi:lint`（Redocly）、`npm run test:openapi`、`cd fc && go test ./internal/contract/`，以及 `npm test` / `cd fc && go test ./...`。CI：[`.github/workflows/ci.yml`](.github/workflows/ci.yml)（lint + 契约测；不含需 DB 的集成测）。
- 网页 Settings 中的 **API Accelerate URL** 指向 FC Base URL；空则同源 Vercel。真实 FC URL **禁止进 git**。
- 生产密钥刷新：`npm run secrets:refresh-prod`（细节见 [`fc/README.md`](fc/README.md)）。

# 部署原则（摘要）

- Vercel：海外主站；FC：国内 API 加速。
- API 保持标准 HTTP，便于移植。
- FC 操作、`s deploy` 禁令、密钥文件、省钱规格等：**只维护在 [`fc/README.md`](fc/README.md)**，此处不重复步骤。
