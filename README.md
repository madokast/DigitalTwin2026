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
- **部署**: Vercel（主站）+ 阿里云函数计算（国内 API 加速，见 [`fc/README.md`](fc/README.md)）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

变量说明与约定见 **[`.env.example`](.env.example)**（本地指向专用测试库；生产连接串只放 Vercel / FC prod）。

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
cd fc
export $(grep -v '^#' ../.env | xargs)   # 或自行 export
go run ./cmd/api                         # 默认 :8080；可用 PORT=9090
```

Settings → API Accelerate URL 填 `http://localhost:8080` 或 FC 的 `*.fcapp.run`（仅本机 prefs；**不要**把真实 FC 域名写进仓库）。

## 部署与密钥脚本

| 命令 | 作用 |
|------|------|
| `npm run secrets:rotate-test` | 轮换本地测试库密码 + 两 Token（更新 `.env` / `fc/.env.fc.test`） |
| `npm run secrets:refresh-prod` | 交互刷新生产 env（可跳过单项）→ Vercel production + FC prod → `vercel deploy --prod` |
| `npm run fc:deploy -- test\|prod` | 部署 FC（`tsx fc/scripts/deploy.ts`）；`cd fc && ./scripts/deploy.sh …` 为薄包装 |
| `cd fc && ./scripts/info.sh test\|prod` | 打印 FC HTTP Base URL（不含密钥） |

- **禁止**裸跑 `s deploy`（会明文打印环境变量）。
- FC 操作、省钱规格、安全细则：**只维护在 [`fc/README.md`](fc/README.md)**。

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

HTTP API 由 **Next（Vercel）** 与 **Go（FC）** 双端实现，路径 / 鉴权 / 语义须一致（见 `AGENTS.md`）。

鉴权：`Authorization: Bearer <token>`（`src/proxy.ts` / FC 同等逻辑）。普通 API：AI Token 或 Admin Token；`/api/admin/*`：仅 Admin Token。

**接口契约**以 OpenAPI 3.1 为准：[`openapi/openapi.yaml`](openapi/openapi.yaml)（说明见 [`openapi/README.md`](openapi/README.md)）。根 README 不再维护接口表；实现与测试须与该契约对齐（Phase 1 仅文档，契约测试 CI 与 codegen 尚未落地）。

## 数据库管理

```bash
npm run db:generate   # 改 schema 后生成 migration
npm run db:migrate    # 执行到当前 DATABASE_URL 指向的库
npm run db:check      # 验证表结构
```

## 测试

```bash
npm test              # 使用 .env 测试库，勿对生产库执行
npm run test:watch
cd fc && go test ./...
```

单元测 `src/lib`、`src/proxy`；集成测连真实 PG（migrate → TRUNCATE → 测 → DROP）。Go：有 `DATABASE_URL` 时跑 httptest 冒烟，否则 Skip。

## 项目结构

```
├── src/               # Next 页面、API、prefs、鉴权
├── fc/                # Go HTTP API + 阿里云 FC（见 fc/README.md）
├── openapi/           # OpenAPI 3.1 契约（双端共用源）
├── scripts/           # migrate 辅助、密钥轮换/生产刷新、共享 lib
├── tests/             # API 集成测试
├── drizzle/           # migration
├── docs/              # 设计与开发日志
└── .env.example       # 环境变量说明（复制为 .env）
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
