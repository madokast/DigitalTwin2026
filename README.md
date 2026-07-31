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
- **部署**: Vercel（主）+ 阿里云函数计算（规划中备用）

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

访问 http://localhost:3000 — 在「设置」中填入 Token；可选配置 IANA 时区与 Dashboard summary 开关。

主题：语义色 token（`globals.css`），跟随系统 `prefers-color-scheme` 明暗切换。

## Web 路由

| 路径 | 说明 |
|------|------|
| `/` | Dashboard（prefs 控制是否挂载 Summary） |
| `/records` | 记录列表（分页/过滤；可搜索多 tag chips；表格不显示 UUID） |
| `/records/[id]` | 记录详情（含 UUID）；Admin 双击字段就地编辑，脏数据才显示提交 |
| `/tags` | 标签列表 |
| `/tags/[tag]` | 标签详情：Admin 改名 + 同款记录表 |
| `/settings` | Token / Admin / summary 开关；时区单行下拉（「跟随浏览器（IANA）」） |

客户端 prefs（`src/lib/prefs.ts`）封装 localStorage：禁止业务直接读写。时区默认空=跟随浏览器。Summary：单行布局；标题加载中/概览；时区用 `resolveTimezone()` 首屏即显；请求带 `tz=<IANA>`。

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

## 项目结构

```
├── src/
│   ├── app/           # 页面与 API Route Handlers
│   ├── components/    # 表格、过滤器、Dashboard widget 等
│   ├── db/            # Drizzle schema / 连接
│   ├── lib/           # prefs、鉴权、query、时区工具
│   └── proxy.ts       # Next.js 16：/api/* 鉴权入口
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
- `20260731-development-log.md` — 详情双击编辑（Admin PATCH）
