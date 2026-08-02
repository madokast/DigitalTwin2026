# faas/ — 共享 Go HTTP API（国内 FaaS）

与仓库根目录 Next.js（`src/app/api`）**同一套 HTTP API**，供国内访问；**共用同一 PostgreSQL**（测试库 / 生产库分别对应 test / prod 函数）。网页在设置里填「API 加速地址」指向本服务的 Base URL（当前为阿里云 FC `*.fcapp.run`）；空则仍走 Vercel 同源 `/api`。

布局约定见 [`docs/20260802-faas-multi-cloud.md`](../docs/20260802-faas-multi-cloud.md)：共享二进制在本目录；各云部署壳在 `providers/<id>/`。

详细 Agent 约定见根目录 [`AGENTS.md`](../AGENTS.md)（原则）；**阿里云 FC 操作步骤以 [`providers/aliyun-fc/README.md`](providers/aliyun-fc/README.md) 为准**。

## 双后端一致性（硬性）

| 侧 | 位置 | 职责 |
|----|------|------|
| Next（海外 / 默认） | `src/app/api/**`、`src/lib/**` | Vercel Route Handlers |
| Go FaaS（国内加速） | `faas/`（`cmd/` + `internal/`） | 本目录 HTTP 服务；部署见 `providers/` |

- **新增 / 修改 API：两侧都要改**（路径、方法、鉴权、请求响应语义、校验规则）。
- **测试双份**：Node（Vitest / `tests/api`）+ Go（`cd faas && go test ./...`）。
- 行为真源：现有 TS `src/lib/{auth,tags,timeutil,query,draft,transactiondraft,record,telegram}` 与各 `route.ts`；Go 对齐它们（分层见 [`docs/20260801-api-layering.md`](../docs/20260801-api-layering.md)）。
- 只用**标准 PostgreSQL**（见根 `AGENTS.md` Neon 原则）。
- **共享代码不得** `import` `providers/*`。

当前应对齐的路由：

- `POST /api/log/number`、`POST /api/log/text`、`POST /api/log/transaction`、`POST /api/log/body/weight`
- `POST /api/telegram/probe`（普通 API Token；校验 Telegram 配置并试发消息）
- `POST /api/qqbot/probe`（普通 API Token；校验 QQ Bot 配置并试发消息）
- `POST /api/db/probe`（普通 API Token；短命连接测 Postgres + `public.records`）
- `GET /api/query`、`/api/query/summary`、`/api/query/tags`、`/api/query/transaction/summary`
- `POST /api/admin/tags/rename`、`PATCH /api/admin/records/{id}`

鉴权：`Authorization: Bearer …`；`/api/admin/*` 仅 Admin Token；其余 AI 或 Admin。

### 录入通知（Telegram / QQ Bot，可选）

- 环境变量：
  - Telegram：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`（**两者皆非空**才启用）
  - QQ Bot：`QQBOT_APP_ID`、`QQBOT_APP_SECRET`、`QQBOT_USER_OPENID`（**三键皆非空**才启用）
  - 运行时经统一 `notify_user` 并行发送；未配置的渠道跳过。
- 触发：`POST /api/log/number|text|body/weight` INSERT 成功后推单条；`POST /api/log/transaction` 整单成功后推一条 batch 摘要；均为 best-effort，通知失败不影响 `201`。
- 测试：`POST /api/telegram/probe`、`POST /api/qqbot/probe`（未配置 / 发送失败返回明确英文 `error`；成功 `{ success: true }`）。`DIGITAL_TWIN_TEST=1` 时默认跳过 `notify_user`；设 `NOTIFY_ALLOW_IN_TEST=1` 才允许测试环境实发。
- 模板：根 `.env.test.example`、`faas/providers/aliyun-fc/env.fc.example`、`s.yaml` 的 `environmentVariables`。
- `secrets:rotate-test` **不**轮换通知渠道密钥。
- **禁止**把真实 Bot Token / AppSecret / OpenID 提交进 git。
- **时区**：二进制嵌入 `time/tzdata`，FC 精简运行时无系统 zoneinfo 时 `Asia/Shanghai` 等仍可用。

## 本地开发

```bash
cd faas
# 使用与根目录相同的测试库密钥（或自行 export）
set -a && source ../.env.test && set +a
go test ./...
go run ./cmd/api          # :8080，可用 PORT 覆盖
```

网页设置「API 加速地址」填 `http://localhost:8080` 可联调。

## 目录速览

```text
faas/
  cmd/api/                         # 入口（本地 ListenAndServe；各云 custom/Web runtime 同二进制）
  internal/                        # auth / db / handlers …（不得 import providers/*）
  go.mod
  providers/
    aliyun-fc/                     # 阿里云 FC：s.yaml / deploy --env-file
    tencent-scf/                   # SCF Web：deploy --env-file；密钥打进包
```

## 阿里云 FC 部署

见 **[`providers/aliyun-fc/README.md`](providers/aliyun-fc/README.md)**（`npm run deploy`、`fc:deploy -- --env-file`、省钱规格、`s deploy` 禁令）。
