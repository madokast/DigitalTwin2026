# DigitalTwin2026 开发日志

> 日期：2026-07-31
> 状态：详情 Admin 编辑收尾；FC Go API 可本地跑 + Serverless Devs 可部署；前端只认 Admin Token；用户可见文案英文化

## 0. 今日做成了什么（总览）

在已有查询 / 列表 / 详情只读之上，补齐 **Admin 就地改记录**：一次草稿、一次提交，双击进出编辑尽量零重排。另：落地阿里云 FC（本地 Go HTTP + `s.yaml` 部署骨架、密钥脚本、文档真源），并收紧浏览器鉴权与语言原则。

| 类别 | 已完成 |
|------|--------|
| Admin API | `PATCH /api/admin/records/[id]`；proxy 仅 Admin Token |
| 校验 | `src/lib/record-draft.ts` 前后端共用；单元 + 路由集成测试 |
| 详情 UI | 双击编辑草稿；脏数据才显示提交；成功 refetch；失败展示 error |
| Null | `NullBadge`：斜体淡色、不可选中；真实 `'-'` / `''` 原样 |
| 标签 | 无逗号独立 chip；编辑仅显隐 `×` / `+`；修复占位塌缩导致的文字跳动 |
| Go API | `fc/`：`go run ./cmd/api`，7 路由 + CORS + 鉴权对齐；`go test ./...` |
| FC 部署 | `s.yaml` / `env.yaml`；`scripts/deploy.sh`（禁裸 `s deploy`）；`info.sh`；省钱规格 |
| 设置加速 | prefs `apiAccelerateBase` → UI **API Accelerate URL**；空=同源 Vercel |
| 密钥脚本 | `secrets:rotate-test`；`secrets:refresh-prod`（Vercel prod + FC prod） |
| Vercel | `.vercelignore` 排除整个 `fc/`，避免 bootstrap 撑大上传 |
| 浏览器 Token | 前端只认 Admin Token（`digitaltwin_admin_token`）；服务端仍双 Token |
| 语言 | 用户可见英文；注释/文档中文；原则写入 `AGENTS.md` |
| 文档 | `fc/README.md` 为 FC 操作真源；`AGENTS.md` 精简引用；本日志 |

## 1. Admin PATCH

- 路径：`PATCH /api/admin/records/[id]`
- Body：可编辑字段快照（`happened_at`、`value_number`、`value_text`、`tags`、`objective_context`、`subjective_interpretation`）
- 规则要点：
  - 空串 → `null`（`objective_context` 除外，不允许空）
  - `value_number` / `value_text` 不能同时为空
  - `tags` 非空且每项 `isValidTag`
  - `happened_at` 必填且带时区偏移
- 前端提交时间：人只选墙钟（`datetime-local`），提交时用 `resolveTimezone()` 拼偏移（与 Dashboard / query 一致）

相关：`src/app/api/admin/records/[id]/route.ts`、`src/lib/record-draft.ts`、`src/lib/api-client.ts`。

## 2. 详情页双击编辑

- 有 Admin Token：双击可编辑区进入草稿态
- 无 Admin：双击提示无编辑权限，不进入编辑
- 硬约束：**零重排**——尽量不因换成控件而改变字号、边距、块尺寸
- 字段交互：
  - 时间：日期时间选择器（无时区控件）
  - 数值：光标 + 默认全选
  - 文本 / 客观 / 主观：contentEditable；Null 从空串起编
  - 标签：chip 行内删 / `+` 搜选或回车新建
- 仅草稿相对服务端有差异时显示提交按钮；成功后 refetch 并退出编辑态

相关：`src/app/records/[id]/page.tsx`、`src/components/null-badge.tsx`、`src/components/record-tag-chips.tsx`、`src/lib/datetime-ui.ts`。

## 3. 标签 chip 布局修正

现象：只读 → 编辑时标签文字向左跳。

原因：每个 chip 曾用左侧 `invisible` × + 右侧 ×；进入编辑后左侧改为 `hidden`，占位塌缩。

修正：去掉左侧对称占位；只保留右侧固定宽 `×` 与末尾 `+`，只读用 `invisible` 占位、编辑可见，**不用 `hidden`**，盒模型宽度切换前后一致。

## 4. Go API + FC 部署

### 4.1 本地 Go HTTP

- 目录：`fc/`（标准 `net/http`，不依赖阿里云 SDK 即可本地跑）
- 路由与鉴权对齐 Next：`/api/log/*`、`/api/query*`、`/api/admin/*`
- pgx：`QueryExecModeCacheDescribe`（适配 Neon pooler）
- 设置页 **API Accelerate URL**：本机 prefs；**不用** `NEXT_PUBLIC_*`；真实 FC URL **不进 git**

```bash
cd fc && export $(grep -v '^#' ../.env | xargs) && go run ./cmd/api
# Settings → API Accelerate URL = http://localhost:8080
cd fc && go test ./...
```

### 4.2 Serverless Devs

- `fc/s.yaml` + `fc/env.yaml`（test / prod 函数名；overlay 写在 `overlays.resources.api` 下，勿再包 `props:`）
- 部署：**必须** `./scripts/deploy.sh test|prod`（把 `s deploy` 整段重定向丢弃，防密钥进终端）
- 取 URL：`./scripts/info.sh test|prod`
- 省钱默认：128MB / 0.05 CPU / disk 512 / timeout 30 / `instanceConcurrency: 1` / `minInstances: 0` / `reservedConcurrency: 1`
- 操作说明只维护在 **[`fc/README.md`](../fc/README.md)**；`AGENTS.md` 仅引用

### 4.3 密钥与 Vercel

- `npm run secrets:rotate-test`：轮换测试库密码 + 两 Token；更新 `.env` 与 `fc/.env.fc.test`
- `npm run secrets:refresh-prod`：交互刷新生产 `DATABASE_URL` / Token → Vercel production + 临时 `.env.fc.prod` 部署后删除 → `vercel deploy --prod`
- `.vercelignore` 排除 `fc/` 等，避免本地 `bootstrap` 把上传体积撑到几十 MB
- Vitest `tests/setup.ts`：以 `.env` override 加载，避免 shell 残留旧密钥

实测：配置加速后国内浏览器 API 约 **200–400ms**（仍受 FC→Neon 跨境影响，可接受）。

## 5. 前端只认 Admin Token

- 设置页仅 **Admin Token** → `localStorage` `digitaltwin_admin_token`
- 去掉浏览器侧 `getToken` / `digitaltwin_token`；`api-client` 一律 `getAdminToken()`
- **服务端仍双 Token**：`DIGITAL_TWIN_TOKEN` 给 AI；`DIGITAL_TWIN_ADMIN_TOKEN` 给网页（普通 API 二者皆可，`/api/admin/*` 仅 Admin）

## 6. 语言原则

写入 `AGENTS.md`：

- 用户可见文案一律英文（UI、错误、日志、脚本输出、API `error`、aria-label 等）
- 仅代码注释与文档用中文
- 测试里故意使用的非 ASCII 非法 tag 样例除外

## 7. 今日提交（节选）

```
8c5cccc 用户可见文案统一为英文，并在 AGENTS 写入语言原则。
c5f14cf 前端只认 Admin Token：去掉浏览器侧普通 Token 槽位。
a09bdb9 添加生产密钥刷新脚本，并排除 FC 产物以免撑大 Vercel 上传。
1132007 完善 FC 文档与省钱规格：fc/README 为操作真源，AGENTS 仅引用。
7090104 测试 setup 以 .env override 加载，避免 shell 旧密钥覆盖。
0629231 添加 FC Serverless Devs 部署骨架与测试密钥轮换脚本。
070ae6f 实现阿里云 FC 第一期子集：设置页 API 加速地址与本地可跑 Go HTTP API。
50507eb 修复标签 chip 双击编辑时左侧 × 占位塌缩导致文字跳动。
6a63995 实现记录详情双击编辑：零重排草稿与标签 chip。
f117da6 添加 Admin PATCH 更新记录接口与草稿校验。
```

## 8. 仍待办（摘自 0730 §10）

- 专用录入接口（账单、体重、复盘等）
- 账单汇总 `GET /query/bill/summary`
- Dashboard 其它组件（体重/支出等）
- AI 侧 CLI 包装
- 数据库 COMMENT、数据导出
- ~~阿里云函数计算部署~~（骨架与 test/prod 流程已就绪；日常以 `fc/README.md` 为准）
- 前端：记录删除 / 图表 / 列表行内编辑
