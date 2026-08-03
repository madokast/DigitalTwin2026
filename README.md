# DigitalTwin2026

个人数字孪生系统 — 对「我」本人进行数字化的孪生映射。

录入以 **AI 对话 / HTTP API** 为主（无表单）；网页用于检视记录、标签管理与磨合期纠错。

## 技术栈

- **前端/后端**: Next.js 16 + React 19
- **语言**: TypeScript（网页）+ Go（国内 FC API）
- **样式**: Tailwind CSS 4
- **数据库**: PostgreSQL（Neon）
- **ORM**: Drizzle ORM
- **测试**: Vitest（真实测试库）+ `go test`
- **部署**: Vercel（主站）+ 阿里云函数计算（国内 API 加速，见 [`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.test.example .env.test
# 若仍有旧根 .env：mv .env .env.test
```

变量说明与约定见 **[`.env.test.example`](.env.test.example)**（本地指向专用测试库；生产由 `npm run deploy -- prod` 收集到临时 `.env.prod`）。

### 3. 初始化数据库

```bash
npm run db:migrate
```

空库可从 0 建表（库本身需已在 Neon 创建）。对生产库：

```bash
DATABASE_URL='生产连接串' npm run db:migrate
```

### 4. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000 — 在 Settings 中填入 Admin Token；可选 IANA 时区、Dashboard summary，以及 **API Accelerate URL**（空=同源 Vercel `/api/...`）。

主题：语义色 token（`globals.css`），跟随系统 `prefers-color-scheme`。

### 5. 本地 Go API（可选）

与 Next API 语义对齐；标准 PostgreSQL，不依赖阿里云 SDK：

```bash
cd faas
set -a && source ../.env.test && set +a   # 或自行 export
go run ./cmd/api                         # 默认 :8080；可用 PORT=9090
```

Settings → API Accelerate URL 填 `http://localhost:8080`，或国内加速的 FC / SCF Base URL（仅本机 prefs；**不要**把真实加速域名写进仓库）。

## 部署与密钥脚本

| 命令 | 作用 |
|------|------|
| `npm run secrets:rotate-test` | 轮换本地测试库密码 + 两 Token（只更新 `.env.test`） |
| `npm run deploy -- test` | 用常驻 `.env.test`；**跳过 Vercel**；询问可选 FC/SCF（默认 N） |
| `npm run deploy -- prod` | 先问 Vercel / FC / SCF（默认 N）；任一 Y → `collect-prod-env`（DB 校验后可选 migrate；bot：Enable；有 `.env.test` 时可复用对应键）→ `.env.prod` → 仅部署所选目标；exit 删 `.env.prod` |
| `npm run fc:deploy -- --env-file <path>` | 薄包装部署 FC（读 `FC_FUNCTION_NAME`） |
| `npm run scf:deploy -- --env-file <path>` | 薄包装部署 SCF（读 `SCF_FUNCTION_NAME`） |

- 密钥模板：根 [`.env.test.example`](.env.test.example) → 复制为常驻 `.env.test`；生产由 `collect-prod-env` 写临时 `.env.prod`（`DATABASE_URL` 校验通过后可选 `db:migrate`，默认 N）。
- **禁止**裸跑 `s deploy`（会明文打印环境变量）。FC `s deploy` 输出由包装脚本丢弃；SCF `scf deploy` 可透传（CLI 不打印密钥）。
- FC 操作、省钱规格、安全细则：**只维护在 [`faas/providers/aliyun-fc/README.md`](faas/providers/aliyun-fc/README.md)**；SCF（Go1 / `scf_bootstrap`）：[`faas/providers/tencent-scf/README.md`](faas/providers/tencent-scf/README.md)；多云总览：[`docs/20260802-faas-multi-cloud.md`](docs/20260802-faas-multi-cloud.md)。

## Web 路由

| 路径 | 说明 |
|------|------|
| `/` | Dashboard（prefs 控制是否挂载 Summary） |
| `/records` | 记录列表（分页/过滤；可搜索多 tag chips；表格不显示 UUID） |
| `/records/[id]` | 记录详情（含 UUID）；Admin 双击字段就地编辑，脏数据才显示提交 |
| `/tags` | 标签列表 |
| `/tags/[tag]` | 标签详情：Admin 改名 + 同款记录表 |
| `/settings` | Admin Token；summary 开关；时区；**API Accelerate URL**（空=同源） |

客户端 prefs（`src/lib/prefs.ts`）封装 localStorage。时区默认空=跟随浏览器。`api-client` 按加速 origin 拼 URL。

## API

HTTP API 由 **Next（Vercel）** 与 **Go（阿里云 FC / 腾讯云 SCF，同一 `faas/` 二进制）** 双端实现，路径 / 鉴权 / 语义须一致（见 `AGENTS.md`）。

鉴权：`Authorization: Bearer <token>`（`src/proxy.ts` / FC 同等逻辑）。普通 API：AI Token 或 Admin Token；`/api/admin/*`：仅 Admin Token。

**接口契约**以 OpenAPI 3.1 为准：[`openapi/openapi.yaml`](openapi/openapi.yaml)（说明见 [`openapi/README.md`](openapi/README.md)）。根 README 不再维护接口表。契约基建已收口：`npm run openapi:lint` + `npm run test:openapi` + `cd faas && go test ./internal/contract/`。CI 另跑无 DB 单元测；集成测无库 Skip（可选 secrets 启用）。**不做** codegen / Schemathesis / 新 OpenAPI Phase。本地 Redoc：`npm run openapi:preview`。

## 数据库管理

```bash
npm run db:generate   # 改 schema 后生成 migration
npm run db:migrate    # 执行到当前 DATABASE_URL 指向的库
npm run db:check      # 验证表结构
```

## 测试

```bash
npm run openapi:lint     # Redocly 校验 openapi.yaml
npm run openapi:preview  # 生成 Redoc 静态页 openapi/redoc-static.html
npm run test:openapi     # 契约 fixture（无 DB）
npm test              # 使用 .env.test 测试库，勿对生产库执行
npm run test:watch
npm run test:integration # 双端 API 集成：Node tests/api + Go httpx/dbprobe（需安全 DATABASE_URL）
cd faas && go test ./internal/contract/   # Go 契约（无 DB）
cd faas && go test ./...
```

单元测 `src/lib`、`src/proxy`；API 集成测连真实 PG（migrate → 用例间 TRUNCATE；**不再 DROP** schema）。门闸为安全的 `DATABASE_URL`（host/库名须含 `test` / `TestDigitalTwin`；无则 Skip；unsafe 则拒绝，不 wipe）。Go httptest / dbprobe 集成同规则。本地一键双端：`npm run test:integration`（读 `.env.test`，缺/不安全则 fail-fast）。CI 默认可跑单元测；配置 GitHub secrets `DATABASE_URL`（及可选 Token）可启用 CI 集成测 job。契约测与 DB 无关，见 `openapi/README.md`。

## 项目结构

```
├── src/               # Next 页面、API、prefs、鉴权
├── faas/              # Go HTTP API + providers/aliyun-fc + providers/tencent-scf
├── openapi/           # OpenAPI 3.1 契约（双端共用源）
├── scripts/           # deploy / collect-prod-env、密钥轮换、共享 lib
├── tests/             # API 集成测试（无安全 DATABASE_URL 时 Skip；不 DROP）
├── testdata/          # 双端共享校验样例（decimal、日历日边界等）
├── drizzle/           # migration
├── docs/              # 设计与开发日志
└── .env.test.example  # 环境变量说明（复制为 .env.test）
```

## 数据模型

一张 `records` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (v7) | 主键，时间有序 |
| happened_at | TIMESTAMPTZ | 事件时间 |
| value_number | TEXT | 十进制数字符串字面量（可空；JSON/API 一律 string，禁止 number） |
| value_text | TEXT | 文本（可空；与数值至少填一） |
| tags | TEXT | JSON 数组 |
| objective_context | TEXT | 客观背景（必填） |
| subjective_interpretation | TEXT | 主观解读（可空） |

## 设计文档

详见 `docs/`：

- `20260727-initial-vision.md` — 初始设想
- `20260728-fuzzy-time.md` — 模糊时间
- `20260729-schema-v1.md` — 表与接口定稿
- `20260730-development-log.md` — 开发日志
- `20260731-development-log.md` — 详情编辑、FC、Telegram、语言原则等
- `20260801-development-log.md` — transaction type、保留 tag 前缀
- `20260801-api-layering.md` — 双端 API 分层同构规范
- `20260802-faas-multi-cloud.md` — 多云 FaaS（FC + SCF）与 deploy/collect
- `20260802-db-probe-multi-cloud.md` — 双云延迟对比（probe / summary）
- `20260802-development-log.md` — 多云落地、SCF Go1、可选 migrate
