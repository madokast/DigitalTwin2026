# DigitalTwin2026

个人数字孪生系统 — 对"我"本人进行数字化的孪生映射。

## 技术栈

- **前端/后端**: Next.js 16 + React 19
- **语言**: TypeScript
- **样式**: Tailwind CSS 4
- **数据库**: PostgreSQL (Neon)
- **ORM**: Drizzle ORM
- **部署**: Vercel + Neon

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```bash
DATABASE_URL='postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require'
```

### 3. 初始化数据库

```bash
npm run db:migrate
```

### 4. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 数据库管理

```bash
# 修改 schema 后生成 migration
npm run db:generate

# 执行 migration 到数据库
npm run db:migrate

# 验证表结构
npm run db:check
```

## 项目结构

```
├── src/
│   ├── app/           # Next.js App Router 页面和 API
│   └── db/            # 数据库配置
│       ├── schema.ts  # 表定义
│       └── index.ts   # 连接配置
├── drizzle/           # 自动生成的 migration 文件
├── docs/              # 项目文档
└── public/            # 静态资源
```

## 数据模型

一张记录表，7 个字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | UUID (v7) | 主键，时间有序 |
| happened_at | TIMESTAMPTZ | 事件时间 |
| value_numeric | NUMERIC | 数值型记录（体重、消费等） |
| value_text | TEXT | 文本型记录（叙事、复盘等） |
| tags | TEXT | JSON 数组，标签 |
| objective_context | TEXT | 客观背景（必填） |
| subjective_interpretation | TEXT | 主观解读（可空） |

## 设计文档

详见 `docs/` 目录：

- `20260727-initial-vision.md` — 项目初始设想
- `20260728-fuzzy-time.md` — 模糊时间处理方案
- `20260729-schema-v1.md` — 数据表设计定稿
