# providers/aliyun-fc — 阿里云函数计算部署

共享 Go 二进制在 [`faas/`](../../)（`cmd/` + `internal/`）。**本目录只放阿里云 FC 的 IaC / env / 部署脚本**。

网页在设置里填「API 加速地址」指向本服务的 `*.fcapp.run`；空则仍走 Vercel 同源 `/api`。Agent 原则见根 [`AGENTS.md`](../../../AGENTS.md)；共享 API 说明见 [`faas/README.md`](../../README.md)。

## 密钥与安全

| 密钥 | 存放 |
|------|------|
| 阿里云 AK | `s config add`，别名见 `s.yaml` 的 `access`（当前为 `dt`）→ `~/.s/`，**不进 git** |
| `DATABASE_URL` / Token | 测试：`faas/providers/aliyun-fc/.env.fc.test`；生产：优先用 `npm run secrets:refresh-prod`（部署时临时写 `.env.fc.prod`，结束后删除）。模板 `env.fc.example` |

- **禁止**裸跑 `s deploy`：会明文打印 `environmentVariables`。
- 部署只用 [`scripts/deploy.ts`](scripts/deploy.ts) / [`scripts/deploy.sh`](scripts/deploy.sh) 薄包装（内部 `s deploy` 输出丢弃）。
- 真实 `*.fcapp.run` **禁止进 git**；只粘到浏览器「API 加速地址」。
- 轮换**测试**库密码 + Token：`npm run secrets:rotate-test`（根目录），然后必须再 `cd faas/providers/aliyun-fc && ./scripts/deploy.sh test`。
- 刷新**生产**密钥（Vercel + FC）：见下文「生产密钥刷新」。

### 部署时通知渠道询问

`npx tsx faas/providers/aliyun-fc/scripts/deploy.ts`（或 `./scripts/deploy.sh` / `npm run fc:deploy -- …`）在 `s deploy` 前依次询问：

- `Enable Telegram notify? [y/N]` → N 写空；Y 可选用仓库根 `.env`（齐全则验证），否则手填必填两项并 `sendMessage` 探测（文案 `DigitalTwin2026 deploying`），失败则 `exit 1`
- `Enable QQ Bot notify? [y/N]` → 同上三键 + 主动 C2C 探测
- 选用值写回当前 `.env.fc.<env>`。`secrets:refresh-prod` 调用部署时设 `DT_SKIP_NOTIFY_PROMPT=1`（兼容旧 `DT_SKIP_TELEGRAM_PROMPT`）跳过二次询问。

## 生产密钥刷新（Vercel + FC prod）

交互脚本（TypeScript：根 `scripts/refresh-prod-env.ts`，`npm run secrets:refresh-prod`）流程：

1. **前三项必填**（`DATABASE_URL` / `DIGITAL_TWIN_TOKEN` / `DIGITAL_TWIN_ADMIN_TOKEN`）：每次必须粘贴非空值（Vercel Sensitive `env pull` 常为空，且 FC 部署需要完整串）；回车会提示不能空并继续询问。新填的 `DATABASE_URL` 会真实连库校验。
2. **`Enable Telegram notify? [y/N]`**（默认 N）  
   - N → 将 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_USER_ID` **明确 upsert 为空串**（关闭线上通知）  
   - Y → 必填两键（空拒）→ 掩码确认 → `sendMessage` 探测（文案 `DigitalTwin2026 prod env verify`）；失败则重填
3. **`Enable QQ Bot notify? [y/N]`**（默认 N）  
   - N → 将 `QQBOT_APP_ID` / `QQBOT_APP_SECRET` / `QQBOT_USER_OPENID` **明确 upsert 为空串**  
   - Y → 必填三键 → 确认 → 主动 C2C 探测（同上文案）；失败则重填

然后：

1. 把本次确定的 key（含通知渠道空串）写入 Vercel **production**
2. **临时**写入完整 `faas/providers/aliyun-fc/.env.fc.prod` → `npx tsx faas/providers/aliyun-fc/scripts/deploy.ts prod`（`DT_SKIP_NOTIFY_PROMPT=1`，跳过二次渠道询问）
3. **删除** `.env.fc.prod`
4. `vercel deploy --prod`

```bash
# 仓库根目录
vercel login          # 若未登录
vercel link           # 若无 .vercel/project.json
s config get -a dt    # 确认 FC 部署用的 AK 别名（见 s.yaml access）
npm run secrets:refresh-prod
```

脚本开头会预检：Vercel login/link、以及 `s` CLI + `s.yaml` 的 access 凭证（再 `s info --env prod` 探活）。

之后：

- 脚本会自动 **`vercel deploy --prod`**，使新 env 进入运行中的函数。
- FC：用 `cd faas/providers/aliyun-fc && ./scripts/info.sh prod` 取 Base URL，粘到需要加速的浏览器「API 加速地址」（勿进 git）。

前置：`s config`（`s.yaml` 的 `access`，当前 `dt`）可用；生产库建议已 `DATABASE_URL=… npm run db:migrate`。

## 测试 → 部署一条龙（test）

前置：已开通函数计算；`s config get -a dt`（或你的别名）可用；测试库已 `npm run db:migrate`。

```bash
cd faas
# 1) Go 测试（共享模块）
go test ./...

cd providers/aliyun-fc
cp env.fc.example .env.fc.test   # 首次：填入与根 .env 相同的测试三件套

# 2) 部署（编译 linux 二进制 + 上传；输出丢弃防泄密）
./scripts/deploy.sh test
# 或仓库根: npm run fc:deploy -- test
# 函数名: digitaltwin-api-test

# 3) 拿 Base URL
./scripts/info.sh test
# 示例: https://xxxx.cn-hangzhou.fcapp.run  → 粘到设置「API 加速地址」

# 4) 冒烟（Token 来自 .env.fc.test，勿把 Token 贴进聊天/文档）
curl -s -H "Authorization: Bearer $DIGITAL_TWIN_TOKEN" \
  "$(./scripts/info.sh test)/api/query/summary?tz=Asia/Shanghai"
```

改规格（CPU/内存/并发等）只改 [`s.yaml`](s.yaml)，再执行 `./scripts/deploy.sh test`。当前默认**省钱档**：最低 memory/cpu、空闲缩到 0、`reservedConcurrency: 1`（最多 1 实例）。`pre-deploy` 在 `faas/` 模块根执行 `go build -trimpath -ldflags="-s -w"`，去掉符号表与 DWARF，减小上传的 `bootstrap` 体积。

## 加了新 API 之后怎么更新 FC

1. 在 `faas/` 实现路由 + `go test`
2. `./scripts/deploy.sh test`（覆盖同一函数，URL 通常不变）
3. curl / 网页加速地址验证  
生产密钥与首次 FC prod：根目录 **`npm run secrets:refresh-prod`**（详见上文「生产密钥刷新」）；或手动 `.env.fc.prod` + `./scripts/deploy.sh prod`。

## 本目录文件

```text
providers/aliyun-fc/
  s.yaml             # FC3 资源与规格（pre-deploy 在 ../../ 编译）
  env.yaml           # test / prod 函数名 overlays
  scripts/deploy.ts  # 唯一允许的部署入口（deploy.sh → tsx）
  scripts/deploy.sh  # 薄包装
  scripts/info.sh    # 打印 HTTP Base URL
  env.fc.example     # 密钥模板
```
