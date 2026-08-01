# fc/ — 阿里云函数计算 API（国内加速）

与仓库根目录 Next.js（`src/app/api`）**同一套 HTTP API**，供国内访问；**共用同一 PostgreSQL**（测试库 / 生产库分别对应 test / prod 函数）。网页在设置里填「API 加速地址」指向本服务的 `*.fcapp.run`；空则仍走 Vercel 同源 `/api`。

详细 Agent 约定见根目录 [`AGENTS.md`](../AGENTS.md)（原则）；**操作步骤以本文为准**。

## 双后端一致性（硬性）

| 侧 | 位置 | 职责 |
|----|------|------|
| Next（海外 / 默认） | `src/app/api/**`、`src/lib/**` | Vercel Route Handlers |
| Go FC（国内加速） | `fc/` | 本目录 HTTP 服务 |

- **新增 / 修改 API：两侧都要改**（路径、方法、鉴权、请求响应语义、校验规则）。
- **测试双份**：Node（Vitest / `tests/api`）+ Go（`cd fc && go test ./...`）。
- 行为真源：现有 TS `src/lib/{auth,tags,timeutil,query,draft,transactiondraft,record,telegram}` 与各 `route.ts`；Go 对齐它们（分层见 [`docs/20260801-api-layering.md`](../docs/20260801-api-layering.md)）。
- 只用**标准 PostgreSQL**（见根 `AGENTS.md` Neon 原则）。

当前应对齐的路由：

- `POST /api/log/number`、`POST /api/log/text`、`POST /api/log/transaction`
- `POST /api/telegram/probe`（普通 API Token；校验 Telegram 配置并试发消息）
- `GET /api/query`、`/api/query/summary`、`/api/query/tags`
- `POST /api/admin/tags/rename`、`PATCH /api/admin/records/{id}`

鉴权：`Authorization: Bearer …`；`/api/admin/*` 仅 Admin Token；其余 AI 或 Admin。

### Telegram 录入通知（可选）

- 环境变量：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`（**两者皆非空**才启用；任一为空则运行时跳过通知）。
- 触发：`POST /api/log/number|text` INSERT 成功后推单条；`POST /api/log/transaction` 整单成功后推一条 batch 摘要；均为 best-effort，Telegram 失败不影响 `201`。
- 测试：`POST /api/telegram/probe`（未配置 / 发送失败返回明确英文 `error`；成功 `{ success: true }`）。
- 模板：根 `.env.example`、`fc/env.fc.example`、`fc/s.yaml` 的 `environmentVariables`。
- **部署**：`npx tsx fc/scripts/deploy.ts`（或 `./scripts/deploy.sh`）在 `s deploy` 前会询问是否使用仓库根 `.env` 的 `TELEGRAM_*`；手填允许皆空（关闭通知）；若任一非空则两者必须齐全，并真实 `sendMessage` 文案 `DigitalTwin2026 deploying`，失败则 `exit 1`。选用值会写回当前 `.env.fc.<env>`。`secrets:refresh-prod` 调用部署时会跳过二次询问。
- `secrets:rotate-test` **不**轮换 Telegram；生产刷新走 `deploy.sh prod` 时同样走上述交互（可从根 `.env` 选用）。
- **禁止**把真实 Bot Token / User ID 提交进 git。
- **时区**：二进制嵌入 `time/tzdata`，FC 精简运行时无系统 zoneinfo 时 `Asia/Shanghai` 等仍可用。

## 本地开发

```bash
cd fc
# 使用与根目录相同的测试库密钥（或自行 export）
set -a && source ../.env && set +a   # 或 source .env.fc.test
go test ./...
go run ./cmd/api          # :8080，可用 PORT 覆盖
```

网页设置「API 加速地址」填 `http://localhost:8080` 可联调。

## 密钥与安全

| 密钥 | 存放 |
|------|------|
| 阿里云 AK | `s config add`，别名见 `s.yaml` 的 `access`（当前为 `dt`）→ `~/.s/`，**不进 git** |
| `DATABASE_URL` / Token | 测试：`fc/.env.fc.test`；生产：优先用 `npm run secrets:refresh-prod`（部署时临时写 `.env.fc.prod`，结束后删除）。模板 `env.fc.example` |

- **禁止**裸跑 `s deploy`：会明文打印 `environmentVariables`。
- 部署只用 [`scripts/deploy.ts`](scripts/deploy.ts) / [`scripts/deploy.sh`](scripts/deploy.sh) 薄包装（内部 `s deploy` 输出丢弃）。
- 真实 `*.fcapp.run` **禁止进 git**；只粘到浏览器「API 加速地址」。
- 轮换**测试**库密码 + Token：`npm run secrets:rotate-test`（根目录），然后必须再 `cd fc && ./scripts/deploy.sh test`。
- 刷新**生产**密钥（Vercel + FC）：见下文「生产密钥刷新」。

## 生产密钥刷新（Vercel + FC prod）

交互脚本（TypeScript：`scripts/refresh-prod-env.ts`，`npm run secrets:refresh-prod`）依次询问：`DATABASE_URL`、`DIGITAL_TWIN_TOKEN`、`DIGITAL_TWIN_ADMIN_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_USER_ID`。

- **回车（DB URL / Token 等不可空项）**：跳过 upsert，保留 Vercel 现值。
- **回车（`TELEGRAM_*` 可空项）**：再问一次 —— `[e]` 显式写成空串并 upsert（关闭通知），`[s]` 跳过 upsert。
- 只想加 Telegram：前三项一路回车（skip），只填两个 `TELEGRAM_*`。
- 跳过的必填项从 `vercel env pull` 合并进临时 `.env.fc.prod`，保证 FC 仍能部署。
- `TELEGRAM_*` 最终要么都空，要么都非空。
- 新填的 `DATABASE_URL` 会真实连库校验；**跳过则不校验**。
- 本次若 upsert 了任一 `TELEGRAM_*` 且最终双非空，会 `sendMessage` 探测；**双跳过或显式清空则不测**。
- **全部跳过**：不 upsert 任何 env，只做 FC prod + `vercel deploy --prod`（纯代码部署）。

然后：

1. 仅把**本次有输入**的 key 写入 Vercel **production**
2. **临时**写入完整合并后的 `fc/.env.fc.prod` → `npx tsx fc/scripts/deploy.ts prod`（或 `./scripts/deploy.sh prod`）
3. **删除** `fc/.env.fc.prod`
4. `vercel deploy --prod`

```bash
# 仓库根目录
vercel login          # 若未登录
vercel link           # 若无 .vercel/project.json
s config get -a dt    # 确认 FC 部署用的 AK 别名（见 fc/s.yaml access）
npm run secrets:refresh-prod
```

脚本开头会预检：Vercel login/link、以及 `s` CLI + `s.yaml` 的 access 凭证（再 `s info --env prod` 探活）。

之后：

- 脚本会自动 **`vercel deploy --prod`**，使新 env 进入运行中的函数。
- FC：用 `cd fc && ./scripts/info.sh prod` 取 Base URL，粘到需要加速的浏览器「API 加速地址」（勿进 git）。

前置：`s config`（`s.yaml` 的 `access`，当前 `dt`）可用；生产库建议已 `DATABASE_URL=… npm run db:migrate`。

## 测试 → 部署一条龙（test）

前置：已开通函数计算；`s config get -a dt`（或你的别名）可用；测试库已 `npm run db:migrate`。

```bash
cd fc
cp env.fc.example .env.fc.test   # 首次：填入与根 .env 相同的测试三件套

# 1) Go 测试
go test ./...

# 2) 部署（编译 linux 二进制 + 上传；输出丢弃防泄密）
./scripts/deploy.sh test
# 函数名: digitaltwin-api-test

# 3) 拿 Base URL
./scripts/info.sh test
# 示例: https://xxxx.cn-hangzhou.fcapp.run  → 粘到设置「API 加速地址」

# 4) 冒烟（Token 来自 .env.fc.test，勿把 Token 贴进聊天/文档）
curl -s -H "Authorization: Bearer $DIGITAL_TWIN_TOKEN" \
  "$(./scripts/info.sh test)/api/query/summary?tz=Asia/Shanghai"
```

改规格（CPU/内存/并发等）只改 [`s.yaml`](s.yaml)，再执行 `./scripts/deploy.sh test`。当前默认**省钱档**：最低 memory/cpu、空闲缩到 0、`reservedConcurrency: 1`（最多 1 实例）。

## 加了新 API 之后怎么更新 FC

1. 在 `fc/` 实现路由 + `go test`
2. `./scripts/deploy.sh test`（覆盖同一函数，URL 通常不变）
3. curl / 网页加速地址验证  
生产密钥与首次 FC prod：根目录 **`npm run secrets:refresh-prod`**（详见上文「生产密钥刷新」）；或手动 `.env.fc.prod` + `./scripts/deploy.sh prod`。

## 目录速览

```text
fc/
  cmd/api/           # 入口（本地 ListenAndServe；FC custom runtime 同二进制）
  internal/          # auth / db / handlers …
  s.yaml             # FC3 资源与规格
  env.yaml           # test / prod 函数名 overlays
  scripts/deploy.ts  # 唯一允许的部署入口（deploy.sh → tsx）
  scripts/deploy.sh  # 薄包装
  scripts/info.sh    # 打印 HTTP Base URL
  env.fc.example     # 密钥模板
```
