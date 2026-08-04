# DigitalTwin2026 开发日志

> **2026-08-04 变更提示**：`value_text` / `value_number` 已全量更名为 `raw_content` / `numeric_value`，todo 审计行存储语义亦已变更（本文正文保留当时原样）。详见 [`20260804-rename-value-text-to-raw-content.md`](20260804-rename-value-text-to-raw-content.md)。

> 日期：2026-07-30
> 状态：当日收尾（MVP + 测试基建 + 双 Token / Admin + Web 路由与 Dashboard UI 打磨）

## 0. 今日做成了什么（总览）

一天下来，从空项目到可用的个人数字孪生后端 + App Router 前端，并补齐测试与权限分层：

| 类别 | 已完成 |
|------|--------|
| 工程骨架 | Next.js 16 + React 19 + TS + Tailwind 4；README / `.env.example` / AGENTS.md 约定 |
| 数据库 | Neon PostgreSQL + Drizzle；单表 `records`；migration 可从空库建表 |
| 环境策略 | 本地 `.env` → **专用测试库**；生产 `DATABASE_URL` 只放 Vercel；不引入多 env 文件 |
| 录入 / 查询 API | `POST /api/log/number`、`POST /api/log/text`、`GET /api/query`（分页/过滤/id） |
| Summary | `GET /api/query/summary?tz=`；今日按 IANA 日历日 |
| 标签 API | `GET /api/query/tags`；`POST /api/admin/tags/rename` |
| 鉴权 | Next.js 16 `src/proxy.ts` 统一拦 `/api/*`；AI Token vs Admin Token 分流 |
| 前端 | 真实路由：Dashboard / 记录 / 标签 / 设置；prefs 抽象；Summary 可关；语义色明暗主题 |
| UI 打磨 | Summary 单行骨架；时区首屏即显；设置页时区单行下拉（跟随浏览器 IANA） |
| 自动化测试 | Vitest：单元（tag/auth/proxy/prefs/time）+ API 集成（真 PG） |
| 部署 | Vercel 线上已通；规划阿里云函数计算备用 |

设计原则仍有效：生产只用标准 PostgreSQL；AI 侧 append-only；改库（如 tag rename）只给网页 Admin Token。

---

## 1. 项目初始化

### 1.1 Next.js 项目创建

使用 `create-next-app` 初始化项目：

```bash
npx create-next-app@latest digitaltwin --app --src-dir --eslint --typescript --tailwind --use-npm
```

**技术栈**：
- Next.js 16.2.10
- React 19.2.4
- TypeScript
- Tailwind CSS 4
- App Router + src 目录结构

### 1.2 项目结构调整

将 digitaltwin 子目录的文件移动到根目录，保留原有的 docs 和 README.md。

## 2. 数据库配置

### 2.1 Neon 连接

- **生产 / 主开发库**：Neon 项目 `DigitalTwin2026`（连接串只配在 Vercel）
- **专用测试库**：Neon 项目 `TestDigitalTwin2026`（写入本地 `.env` 的 `DATABASE_URL`）
- 曾讨论 Neon 临时分支；最终采用「独立测试库 + migrate/TRUNCATE/DROP」，避免业务绑 Neon branching

**环境变量**（见 `.env.example`）：

```
DATABASE_URL=          # 本地指向测试库；生产在 Vercel
DIGITAL_TWIN_TOKEN=    # AI / 普通 API
DIGITAL_TWIN_ADMIN_TOKEN=  # 仅 /api/admin/*；勿交给 AI
```

对生产建表 / 迁移：

```bash
DATABASE_URL='生产连接串' npm run db:migrate
```

空库只要库已存在，migrate 可从 0 建表（不负责 `CREATE DATABASE`）。

### 2.2 Drizzle ORM 集成

```bash
npm install drizzle-orm postgres
npm install -D drizzle-kit
```

**设计原则**（AGENTS.md）：
- 生产代码只用标准 PostgreSQL 功能，不依赖 Neon 特色
- 测试可用独立测试库（或 Neon 分支，非必须）

### 2.3 数据表设计

**records 表**（唯一表）：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | UUID (v7) | PK, NOT NULL | 唯一 ID，时间有序 |
| happened_at | TIMESTAMPTZ | NOT NULL | 事件时间 |
| value_number | NUMERIC | 可空 | 数值型记录（体重、消费等） |
| value_text | TEXT | 可空 | 文本型记录（叙事、复盘等） |
| tags | TEXT | NOT NULL | JSON 数组，标签 |
| objective_context | TEXT | NOT NULL | 客观背景描述 |
| subjective_interpretation | TEXT | 可空 | 主观解读 |

**约束**：
- `chk_value`：value_number 和 value_text 不能同时为空
- `chk_tags`：tags 必须是有效的 JSON 数组

### 2.4 字段演进过程

1. **初始设计**：`context` 字段（可空）
2. **第一次修改**：`context` → `objective_context`（必填），新增 `subjective_interpretation`（可空）
3. **第二次修改**：`value_numeric` → `value_number`（更符合业务命名习惯）

## 3. API 接口开发

### 3.1 接口一览

| 接口 | 方法 | 用途 | Token |
|---|---|---|---|
| `/api/log/number` | POST | 记录数值 | AI 或 Admin |
| `/api/log/text` | POST | 记录文本 | AI 或 Admin |
| `/api/query` | GET | 通用查询 | AI 或 Admin |
| `/api/query/tags` | GET | 全表 tag 计数（按 tag 名字典序） | AI 或 Admin |
| `/api/admin/tags/rename` | POST | 全局 tag 替换 `{ from, to }` | **仅 Admin** |

成功响应统一带 `{ success, ... }`；失败为 `{ error }`。

### 3.2 认证机制（Next.js 16 Proxy）

鉴权集中在 [`src/proxy.ts`](../src/proxy.ts)，`matcher: '/api/:path*'`：

- 普通 `/api/*`：`DIGITAL_TWIN_TOKEN` **或** `DIGITAL_TWIN_ADMIN_TOKEN`
- `/api/admin/*`：仅 `DIGITAL_TWIN_ADMIN_TOKEN`（AI 即使知道 path 也无法操作）

各 Route Handler 不再重复写鉴权代码。

```
Authorization: Bearer <token>
```

### 3.3 Tag 格式验证

**规则**：
- 只能用：英文字母、数字、下划线、冒号
- 不能以数字开头
- 冒号不能开头、结尾、连续
- 至少一个字符

**正则表达式**：`/^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*$/`

**允许的示例**：`weight`、`source:device`、`review:weekly`  
**禁止的示例**：`:device`、`source:`、`source::device`、`体重`

### 3.4 查询接口

支持的过滤条件：
- `from` / `to`：时间区间（ISO 8601 **必须**带时区 `Z`/`±offset`；无偏移或纯日期拒绝），半开区间 `[from, to)`
- `tag`：多 tag 过滤（AND 语义）
- `q`：模糊搜索（value_text、objective_context、subjective_interpretation、tags）

### 3.5 标签计数与全局替换

- `GET /api/query/tags` → `{ success: true, tags: { morning: 1, weight: 2, ... } }`（key 字典序）
- `POST /api/admin/tags/rename` → 精确替换 tag 名；同条记录若 `to` 已存在则去重；返回 `{ success, updated }`

## 4. 前端页面

### 4.1 页面结构

移动端优先单页三态（后扩展为四态）：

- **首页**：查看记录 / 标签管理 / 设置
- **设置**：API Token + Admin Token（localStorage：`digitaltwin_token` / `digitaltwin_admin_token`）
- **记录**：表格只读展示
- **标签管理**：展示 tag 计数；Admin Token 下做全局替换

### 4.2 功能特性

- 双 Token 持久化；Admin 仅网页使用
- 响应式表格；标签蓝色 chip

## 5. 自动化测试

### 5.1 方案

- 框架：**Vitest**
- 单元：`src/lib/*.test.ts`、`src/proxy.test.ts`（无库 / 测鉴权分流）
- 集成：`tests/api/*.test.ts` 直接调 Route Handler + **真实测试 PG**
- 生命周期：migrate → 每用例 TRUNCATE → 套件结束 DROP
- 不使用 SQLite / mock DB；不绑 Neon branching

### 5.2 命令

```bash
npm test
npm run test:watch
```

当日验证约 **49** 条用例通过。

## 6. 部署

### 6.1 Vercel

1. 代码推送到 GitHub  
2. Vercel 导入项目  
3. 环境变量：`DATABASE_URL`、`DIGITAL_TWIN_TOKEN`、`DIGITAL_TWIN_ADMIN_TOKEN`  
4. 自动部署  

**线上地址**：https://digital-twin2026.vercel.app  

Schema 变更需另对生产执行 `DATABASE_URL='...' npm run db:migrate`（部署不会自动 migrate）。

### 6.2 部署规划

- **Vercel**：主要（海外）
- **阿里云函数计算**：国内备用
- API 保持标准，便于移植

## 7. 早期手工测试备忘

```bash
curl -X POST http://localhost:3001/api/log/number \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"happened_at":"2026-07-30T08:00:00+08:00","value_number":75.5,"tags":["weight"],"objective_context":"早上空腹称重"}'

curl -X GET "http://localhost:3001/api/query/tags" \
  -H "Authorization: Bearer $TOKEN"
```

线上曾对基础录入/查询接口验证通过。

## 8. Web 路由与仪表盘改造（同日续）

将单页状态机替换为真实 App Router：

- **prefs**（`src/lib/prefs.ts`）：Token / Admin / `dashboard.summary` / `timezone`；业务禁止直接 `localStorage`
- **时区**：IANA；空=跟随浏览器；Settings 用 `Intl.supportedValuesOf('timeZone')`
- **Summary**：`GET /api/query/summary?tz=`；Dashboard 关则不挂载、不请求
- **Query**：默认 `page=1` `pageSize=20`；多 tag AND；`q`；可选 `id`；`from`/`to` 须为 ISO8601 且带时区（`Z` / `±HH:MM` / `±HHMM`），纯日期或无偏移 → 400；半开区间；`happenedAt` desc
- **页面**：`/`、`/records`、`/records/[id]`、`/tags`、`/tags/[tag]`、`/settings`；布局导航；表格无 UUID、长文本截断
- **记录筛选 UI**：`TagMultiSelect` 可搜索多 tag chips（AND）；日期按 prefs 时区展开为带偏移的 `from`/`to`

相关提交（新 → 旧）：

```
c320fcd 将记录筛选改为可搜索的多 tag chips，并放宽远端测试超时
f5bd40b 强制 query 的 from/to 必须带时区，拒绝无偏移时间串
1a865c0 打通全局导航并同步 README 与开发日志
692b8d7 补上标签列表与详情页，并复用同一套记录表
397c6d4 扩展查询分页过滤并补上记录列表与详情页
a69b211 添加按 IANA 时区计算「今日」的 summary API 与仪表盘组件
1ef3227 封装 prefs 与设置页，避免业务直接读写 localStorage
```

## 8.1 今日收尾（同日后期）

文档对齐前的后期 commits（UI / 主题）：

- **明暗主题**：`globals.css` 语义色 token，跟随 `prefers-color-scheme`（`b391d69`）
- **Summary UI**：始终单行数字骨架，避免加载跳动；标题「加载中」→「概览」（`91855e8`）
- **时区首屏**：Summary 用 `resolveTimezone()` 本地即显，不依赖 API 返回（`89e37b1`）
- **设置时区**：单行 `<select>` + 搜索；空选项文案「跟随浏览器（实际 IANA）」（`5bb18de`）
- **文档**：此前已补 from/to 强制时区与多 tag chips（`10c8a05`）；本收尾再对齐主题 / Summary / 时区下拉

相关提交（新 → 旧）：

```
5bb18de 将设置页时区改为单行下拉，并显示浏览器实际 IANA
89e37b1 修复 SummaryWidget：时区首屏用 resolveTimezone 渲染，不再等待 API
91855e8 修复 SummaryWidget 加载时布局跳动：始终渲染单行数字骨架
b391d69 统一明暗主题：用语义色 token 替换写死灰阶，跟随系统配色
10c8a05 补充文档：from/to 强制时区与多 tag chips 筛选
```

## 9. Git 提交记录（节选，新 → 旧）

```
a257c91 补充开发日志与 README，使文档与当前 MVP、双 Token 与测试现状对齐
3e5260c 添加 admin 鉴权与标签全局替换接口
1d3895e 将 API Bearer 鉴权集中到 Next.js 16 proxy
7da10b3 添加 GET /api/query/tags 标签计数接口
8b19887 添加 Vitest 单元与 API 集成测试基建
d8e9466 添加 .env.example 并允许其提交
5eba1b1 添加 2026-07-30 开发日志
d620446 重构页面：移动端优先
a01628c 创建数据展示页面
d1ed87c / 995a2ed tag 格式规则
7f3f285 创建三个通用 API 接口
91346c0 / 55dbc1b 字段演进
98f4aba 配置 Neon
c3e2f25 初始化 Next.js 项目
```

## 10. 待办事项

- [ ] 专用录入接口（账单、体重、复盘等，见 schema-v1 设计）
- [ ] 账单汇总（transaction summary；路径待定）
- [ ] Dashboard 其它组件（体重/支出等；prefs 已留扩展位）
- [ ] AI 侧 CLI 包装（只注入 AI Token，永不接触 Admin）
- [ ] 添加数据库注释（COMMENT ON）
- [ ] 数据导出
- [ ] 阿里云函数计算版本
- [x] 前端记录详情双击编辑（Admin PATCH；见 20260731 日志）
- [ ] 前端记录删除 / 图表 / 列表行内编辑
