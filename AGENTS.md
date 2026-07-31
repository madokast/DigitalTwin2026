<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Neon 使用原则

- **生产代码**：只用标准 PostgreSQL 功能，不依赖 Neon 特色（如 branching、serverless driver 等）。确保可随时切换到普通 PG。
- **测试环境**：可以用 Neon 分支功能创建临时分支跑测试，测完删除分支，不污染主库。

# 部署规划

- **Vercel**：主要部署平台（海外访问）
- **阿里云函数计算**：国内备用（Vercel 可能被墙）
- **API 保持标准**：便于移植到不同 serverless 平台

# 本地 Go API（`fc/`）

- 与 Next 7 条 `/api/*` 语义对齐；`cd fc && go run ./cmd/api`（`:8080` / `PORT`）
- 环境变量仅后端：`DATABASE_URL`、`DIGITAL_TWIN_TOKEN`、`DIGITAL_TWIN_ADMIN_TOKEN`
- 设置页「API 加速地址」存本机 prefs；空=同源 Vercel；**禁止** `NEXT_PUBLIC_*` 下发；**禁止**真实 FC URL 进 git
- 本期未做：Serverless Devs / `s.yaml` / 控制台部署
