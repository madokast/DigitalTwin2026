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
