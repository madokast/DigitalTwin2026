# DigitalTwin2026

个人数字孪生系统 — 对「我」本人进行数字化的孪生映射。

录入以 **AI 对话 / HTTP API** 为主（无表单）；网页用于检视记录、标签管理与磨合期纠错。

## 技术栈

- **前端/后端**: Next.js 16 + React 19
- **语言**: TypeScript
- **样式**: Tailwind CSS 4
- **数据库**: PostgreSQL（Neon）
- **ORM**: Drizzle ORM
- **测试**: Vitest（真实测试库）
- **部署**: Vercel（主）+ 阿里云函数计算（规划中；本期仅本地 Go API）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`（本地指向**专用测试库**，生产连接串只放 Vercel）：

| 变量 | 用途 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `DIGITAL_TWIN_TOKEN` | AI / 普通 API（查询、录入） |
| `DIGITAL_TWIN_ADMIN_TOKEN` | 仅 `/api/admin/*`；只给网页，**勿交给 AI** |

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

访问 http://localhost:3000 — 在「设置」中填入 Token；可选配置 IANA 时区、Dashboard summary，以及 **API 加速地址**（空=同源 Vercel `/api/...`）。

### 阿里云 FC（Serverless Devs）

1. 本机已 `s config add`（AK 在 `~/.s/`，勿进仓库）且开通函数计算 + `AliyunFCFullAccess`
2. 在 `fc/` 准备密钥文件（gitignore）：

```bash
cd fc
cp env.fc.example .env.fc.test
# 编辑填入测试库 DATABASE_URL 与两个 Token
./scripts/deploy.sh test   # 内部 s deploy >/dev/null；禁止裸跑 s deploy（会明文打出密钥）
```

轮换本地测试库密码与 Token（只改 `.env` / `fc/.env.fc.test` 匹配行；打印旧→新掩码）：

```bash
npm run secrets:rotate-test
# 然后务必再 ./scripts/deploy.sh test 把新密钥注入 FC
```

3. 用 `s info --env test` 查看 `*.fcapp.run`，**只粘到浏览器设置 → API 加速地址**，不要写进 git  
4. 生产：复制为 `.env.fc.prod`（生产库与 Vercel 相同），确认 test 无误后再 `./scripts/deploy.sh prod`

区域默认 `cn-hangzhou`（见 `fc/s.yaml`）。

主题：语义色 token（`globals.css`），跟随系统 `prefers-color-scheme` 明暗切换。

### 5. 本地 Go API（国内备用镜像，可选）

语义对齐现有 7 条 Next API，标准 PostgreSQL，不依赖阿里云 SDK 即可本地跑：

```bash
cd fc
# 需 DATABASE_URL、DIGITAL_TWIN_TOKEN、DIGITAL_TWIN_ADMIN_TOKEN（与根目录 .env 一致）
export $(grep -v '^#' ../.env | xargs)   # 或自行 export
go run ./cmd/api                         # 默认 :8080；可用 PORT=9090
```

网页「设置 → API 加速地址」填本地 `http://localhost:8080` 或部署后的 FC HTTP 域名（仅本机 prefs；**不要**把真实 FC 域名写进仓库）。空则仍走同源 Vercel。

部署骨架：`fc/s.yaml` + `fc/scripts/deploy.sh`（custom.debian10）。**未默认替你执行**云上 deploy，需本地准备 `.env.fc.test` 后自行跑脚本。

## Web 路由

| 路径 | 说明 |
|------|------|
| `/` | Dashboard（prefs 控制是否挂载 Summary） |
| `/records` | 记录列表（分页/过滤；可搜索多 tag chips；表格不显示 UUID） |
| `/records/[id]` | 记录详情（含 UUID）；Admin 双击字段就地编辑，脏数据才显示提交 |
| `/tags` | 标签列表 |
| `/tags/[tag]` | 标签详情：Admin 改名 + 同款记录表 |
| `/settings` | Token / Admin / summary 开关；时区；**API 加速地址**（空=同源） |

客户端 prefs（`src/lib/prefs.ts`）封装 localStorage：禁止业务直接读写。时区默认空=跟随浏览器。Summary：单行布局；标题加载中/概览；时区用 `resolveTimezone()` 首屏即显；请求带 `tz=<IANA>`。`api-client` 按 prefs 的加速 origin 拼 URL（规范化去尾 `/`）。

## API 一览

鉴权：`Authorization: Bearer <token>`，由 `src/proxy.ts` 统一拦截 `/api/*`。

| 接口 | 方法 | 说明 | Token |
|------|------|------|-------|
| `/api/log/number` | POST | 记数值 | AI 或 Admin |
| `/api/log/text` | POST | 记文本 | AI 或 Admin |
| `/api/query` | GET | 分页查询：`page`/`pageSize`（默认 1/20）、`from`/`to`（须带 `Z`/`±HH:MM`，无偏移或纯日期 → 400；半开区间）、多 `tag` AND、`q`、可选 `id`；`happenedAt` 倒序 | AI 或 Admin |
| `/api/query/summary` | GET | 概览：必填 `tz`（IANA）；返回 `{ total, today, tz }`，今日=该时区日历日 | AI 或 Admin |
| `/api/query/tags` | GET | 全表 tag→条数（字典序） | AI 或 Admin |
| `/api/admin/tags/rename` | POST | 全局 tag 替换 `{ from, to }` | **仅 Admin** |
| `/api/admin/records/[id]` | PATCH | 更新记录可编辑字段快照（`happened_at` / `value_*` / `tags` / 客观·主观）；空串→null（`objective_context` 除外） | **仅 Admin** |

成功响应形如 `{ "success": true, ... }`；失败为 `{ "error": "..." }`。

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
```

单元测 `src/lib`、`src/proxy`；集成测连真实 PG（migrate → TRUNCATE → 测 → DROP）。

Go API：

```bash
cd fc && go test ./...
# 有 DATABASE_URL 时会跑 httptest 集成冒烟；否则自动 Skip
```

## 项目结构

```
├── src/
│   ├── app/           # 页面与 API Route Handlers
│   ├── components/    # 表格、过滤器、Dashboard widget 等
│   ├── db/            # Drizzle schema / 连接
│   ├── lib/           # prefs、鉴权、query、时区、api-client
│   └── proxy.ts       # Next.js 16：/api/* 鉴权入口
├── fc/                # Go HTTP API（本地 go run；FC 部署后续）
│   ├── cmd/api/       # 入口 :8080 / PORT
│   └── internal/      # auth / db / tags / timeutil / draft / query / logapi / httpx
├── tests/             # API 集成测试与 helpers
├── drizzle/           # migration
├── docs/              # 设计与开发日志
└── public/
```

## 数据模型

一张 `records` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID (v7) | 主键，时间有序 |
| happened_at | TIMESTAMPTZ | 事件时间 |
| value_number | NUMERIC | 数值（可空） |
| value_text | TEXT | 文本（可空；与数值至少填一） |
| tags | TEXT | JSON 数组 |
| objective_context | TEXT | 客观背景（必填） |
| subjective_interpretation | TEXT | 主观解读（可空） |

## 设计文档

详见 `docs/`：

- `20260727-initial-vision.md` — 初始设想
- `20260728-fuzzy-time.md` — 模糊时间
- `20260729-schema-v1.md` — 表与接口定稿
- `20260730-development-log.md` — 当日开发日志与已完成项
- `20260731-development-log.md` — 详情双击编辑；本地 Go API + 设置页加速地址（FC 部署仍待办）
