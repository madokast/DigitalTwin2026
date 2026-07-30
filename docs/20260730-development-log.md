# DigitalTwin2026 开发日志

> 日期：2026-07-30
> 状态：进行中

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

注册 Neon 账号，创建项目，获取连接字符串。

**环境变量配置**（`.env`）：
```
DATABASE_URL='postgresql://neondb_owner:xxx@ep-xxx.neon.tech/neondb?sslmode=require'
DIGITAL_TWIN_TOKEN='your-secret-token-here'
```

### 2.2 Drizzle ORM 集成

安装依赖：
```bash
npm install drizzle-orm postgres
npm install -D drizzle-kit
```

**设计原则**（记录在 AGENTS.md）：
- 生产代码只用标准 PostgreSQL 功能，不依赖 Neon 特色
- 测试环境可以用 Neon 分支功能

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

### 3.1 接口设计

三个通用接口：

| 接口 | 方法 | 用途 |
|---|---|---|
| `/api/log/number` | POST | 记录数值 |
| `/api/log/text` | POST | 记录文本 |
| `/api/query` | GET | 通用查询 |

### 3.2 认证机制

使用标准 Bearer Token 认证：
```
Authorization: Bearer <token>
```

Token 通过环境变量 `DIGITAL_TWIN_TOKEN` 配置。

### 3.3 Tag 格式验证

**规则**：
- 只能用：英文字母、数字、下划线、冒号
- 不能以数字开头
- 冒号不能开头、结尾、连续
- 至少一个字符

**正则表达式**：`/^[a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z0-9_]+)*$/`

**允许的示例**：
- `weight`
- `source:device`
- `review:weekly`

**禁止的示例**：
- `:device`（冒号开头）
- `source:`（冒号结尾）
- `source::device`（连续冒号）
- `体重`（中文）

### 3.4 查询接口

支持的过滤条件：
- `from` / `to`：时间区间（ISO 8601 带时区）
- `tag`：多 tag 过滤（AND 语义）
- `q`：模糊搜索（value_text、objective_context、subjective_interpretation、tags）

## 4. 前端页面

### 4.1 页面结构

采用移动端优先设计：

- **首页**：简洁设计
  - 「查看记录」按钮
  - 「设置」按钮
- **设置页面**：Token 输入 + 保存（存 localStorage）
- **记录页面**：表格展示所有记录

### 4.2 功能特性

- Token 持久化（localStorage）
- 响应式设计（移动端优先，桌面端自适应）
- 表格展示所有字段
- 标签以蓝色标签样式显示

## 5. 部署

### 5.1 Vercel 部署

1. 代码推送到 GitHub
2. Vercel 导入项目
3. 配置环境变量：
   - `DATABASE_URL`
   - `DIGITAL_TWIN_TOKEN`
4. 自动部署

**线上地址**：https://digital-twin2026.vercel.app

### 5.2 部署规划

- **Vercel**：主要部署平台（海外访问）
- **阿里云函数计算**：国内备用（Vercel 可能被墙）
- API 保持标准，便于移植

## 6. 测试结果

### 6.1 本地测试

```bash
# 记录数值
curl -X POST http://localhost:3001/api/log/number \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"happened_at":"2026-07-30T08:00:00+08:00","value_number":75.5,"tags":["weight"],"objective_context":"早上空腹称重"}'

# 记录文本
curl -X POST http://localhost:3001/api/log/text \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"happened_at":"2026-07-30T10:00:00+08:00","value_text":"今天背了50个单词","tags":["study","vocabulary"],"objective_context":"下午学习时间"}'

# 查询
curl -X GET "http://localhost:3001/api/query?tag=weight" \
  -H "Authorization: Bearer $TOKEN"
```

### 6.2 线上测试

所有接口在 Vercel 上测试通过。

## 7. Git 提交记录

```
d620446 重构页面：移动端优先
a01628c 创建数据展示页面
d1ed87c 完善 tag 规则：冒号不能开头、结尾、连续
995a2ed 添加 tag 格式验证：只允许英文、数字、下划线、冒号，不能以数字开头
78402cb 记录部署规划：Vercel 主要 + 阿里云函数计算备用
7f3f285 创建三个通用 API 接口
ba42d44 更新 README：项目说明、技术栈、使用指南
91346c0 字段重命名：value_numeric → value_number
55dbc1b 修改字段：context → objective_context（必填），新增 subjective_interpretation（可空）
98f4aba 配置 Neon 数据库连接
c3e2f25 初始化 Next.js 项目
```

## 8. 待办事项

- [ ] 创建更多专用接口（账单、体重、复盘等）
- [ ] 添加数据库注释（COMMENT ON）
- [ ] 完善查询接口（支持更多过滤条件）
- [ ] 添加数据导出功能
- [ ] 实现阿里云函数计算版本
