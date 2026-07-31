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
- 行为真源：现有 TS `src/lib/{auth,tags,time,query-records,record-draft}` 与各 `route.ts`；Go 对齐它们。
- 只用**标准 PostgreSQL**（见根 `AGENTS.md` Neon 原则）。

当前应对齐的路由：

- `POST /api/log/number`、`POST /api/log/text`
- `GET /api/query`、`/api/query/summary`、`/api/query/tags`
- `POST /api/admin/tags/rename`、`PATCH /api/admin/records/{id}`

鉴权：`Authorization: Bearer …`；`/api/admin/*` 仅 Admin Token；其余 AI 或 Admin。

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
| `DATABASE_URL` / Token | `fc/.env.fc.test`、`fc/.env.fc.prod`（gitignore）；模板 `env.fc.example` |

- **禁止**裸跑 `s deploy`：会明文打印 `environmentVariables`。
- 部署只用 [`scripts/deploy.sh`](scripts/deploy.sh)（内部 `s deploy … >/dev/null`）。
- 真实 `*.fcapp.run` **禁止进 git**；只粘到浏览器「API 加速地址」。
- 轮换测试库密码 + Token：`npm run secrets:rotate-test`（根目录），然后必须再 `./scripts/deploy.sh test`。

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
生产：准备 `.env.fc.prod`（与 Vercel **同一生产库**）→ test 通过后再 `./scripts/deploy.sh prod`（函数名 `digitaltwin-api-prod`）。

## 目录速览

```text
fc/
  cmd/api/           # 入口（本地 ListenAndServe；FC custom runtime 同二进制）
  internal/          # auth / db / handlers …
  s.yaml             # FC3 资源与规格
  env.yaml           # test / prod 函数名 overlays
  scripts/deploy.sh  # 唯一允许的部署入口
  scripts/info.sh    # 打印 HTTP Base URL
  env.fc.example     # 密钥模板
```
