# faas/ — 共享 Go HTTP API（国内 FaaS）

与仓库根目录 Next.js（`src/app/api`）**同一套 HTTP API**，供国内访问；**共用同一 PostgreSQL**（测试库 / 生产库分别对应 test / prod 函数）。网页在设置里填「API 加速地址」指向本服务的 Base URL（**阿里云 FC 或腾讯云 SCF 任一**）；空则仍走 Vercel 同源 `/api`。真实 URL **禁止进 git**。

布局约定见 [`docs/20260802-faas-multi-cloud.md`](../docs/20260802-faas-multi-cloud.md)：共享二进制在本目录；各云部署壳在 `providers/<id>/`。

详细 Agent 约定见根目录 [`AGENTS.md`](../AGENTS.md)（原则）；**阿里云 FC** 以 [`providers/aliyun-fc/README.md`](providers/aliyun-fc/README.md) 为准；**腾讯云 SCF**（Web + Go1）以 [`providers/tencent-scf/README.md`](providers/tencent-scf/README.md) 为准。

## 双后端一致性（硬性）

| 侧 | 位置 | 职责 |
|----|------|------|
| Next（海外 / 默认） | `src/app/api/**`、`src/lib/**` | Vercel Route Handlers |
| Go FaaS（国内加速） | `faas/`（`cmd/` + `internal/`） | 本目录 HTTP 服务；部署见 `providers/` |

- **新增 / 修改 API：两侧都要改**（路径、方法、鉴权、请求响应语义、校验规则）。
- **测试双份**：Node（Vitest / `tests/api`）+ Go（`cd faas && go test ./...`）。
- 行为真源：现有 TS `src/lib/{auth,tags,timeutil,query,draft,transactiondraft,record,telegram}` 与各 `route.ts`；Go 对齐它们（分层见 [`docs/20260801-api-layering.md`](../docs/20260801-api-layering.md)）。
- 只用**标准 PostgreSQL**（见根 `AGENTS.md`「数据库」节）。
- **共享代码不得** `import` `providers/*`。

当前应对齐的路由：

- `POST /api/log/number`、`POST /api/log/text`、`POST /api/log/transaction`、`POST /api/log/body/weight`、`POST /api/log/todo`、`POST /api/log/todo/transition`
- `POST /api/telegram/probe`（普通 API Token；校验 Telegram 配置并试发消息）
- `POST /api/qqbot/probe`（普通 API Token；校验 QQ Bot 配置并试发消息）
- `POST /api/db/probe`（普通 API Token；短命连接测 Postgres + `public.records`）
- `GET /api/query`、`/api/query/summary`、`/api/query/tags`、`/api/query/transaction/summary`
- `GET /api/export/records`（ApiToken；`from?` + 必填 `limit`；NDJSON 有界缓冲下载，非 DB cursor 无限流）
- `POST /api/admin/tags/rename`、`PATCH /api/admin/records/{id}`
- `POST /api/admin/import/records`（AdminToken；multipart `file`≤4MiB 读入后逐行 upsert）

鉴权：`Authorization: Bearer …`；`/api/admin/*` 仅 Admin Token；其余 AI 或 Admin。备份 / 迁移 JSONL 决策真源：[`docs/20260803-records-import-export.md`](../docs/20260803-records-import-export.md)。

### 录入通知（Telegram / QQ Bot，可选）

- 环境变量：
  - Telegram：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`（**两者皆非空**才启用）
  - QQ Bot：`QQBOT_APP_ID`、`QQBOT_APP_SECRET`、`QQBOT_USER_OPENID`（**三键皆非空**才启用）
  - 运行时经统一 `notify_user` 并行发送；未配置的渠道跳过。
- 触发：`POST /api/log/number|text|body/weight|todo` INSERT 成功后推单条；`POST /api/log/todo/transition` 成功后推**审计文案**一条；`POST /api/log/transaction` 整单成功后推一条 batch 摘要；`GET /api/export/records` / `POST /api/admin/import/records` 成功（含空）各推一次；均为 best-effort，通知失败不影响成功响应。
- 测试：`POST /api/telegram/probe`、`POST /api/qqbot/probe`（未配置 / 发送失败返回明确英文 `error`；成功 `{ success: true }`）。业务自动 notify 静音靠进程 env **`SUPPRESS_BOT_NOTIFICATION`**（trim 后严格 `'1'` 才跳过 `notify_user`）：本地 `.env.test` 写 `=1`；`deploy -- test` 强制注入 `=1`，`deploy -- prod` 强制 `=0`（不问用户）。**probe 不受该开关约束**，仍直调渠道发送。决策真源：[`docs/20260803-suppress-bot-notification.md`](../docs/20260803-suppress-bot-notification.md)。
- 模板：根 [`.env.test.example`](../.env.test.example)；`s.yaml` 的 `environmentVariables`。
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
    aliyun-fc/                     # 阿里云 FC：s.yaml / deploy --env-file；s deploy 输出丢弃
    tencent-scf/                   # SCF Web Go1：deploy --env-file；密钥打进包；CLI 输出透传
```

## 部署入口

推荐仓库根：`npm run deploy -- test|prod`（见 multi-cloud 文档 §4）。薄包装：

- FC：[`providers/aliyun-fc/README.md`](providers/aliyun-fc/README.md)（`fc:deploy -- --env-file`、省钱规格、`s deploy` 禁令）
- SCF：[`providers/tencent-scf/README.md`](providers/tencent-scf/README.md)（`scf:deploy -- --env-file`、Go1 / `scf_bootstrap`、`scf login`）
