# providers/aliyun-fc — 阿里云函数计算部署

共享 Go 二进制在 [`faas/`](../../)（`cmd/` + `internal/`）。**本目录只放阿里云 FC 的 IaC / env / 部署脚本**。

网页在设置里填「API 加速地址」指向本服务的 `*.fcapp.run`；空则仍走 Vercel 同源 `/api`。Agent 原则见根 [`AGENTS.md`](../../../AGENTS.md)；共享 API 说明见 [`faas/README.md`](../../README.md)。

## 密钥与安全

| 密钥 | 存放 |
|------|------|
| 阿里云 AK | `s config add`，别名见 `s.yaml` 的 `access`（当前为 `dt`）→ `~/.s/`，**不进 git** |
| `DATABASE_URL` / Token / `FC_FUNCTION_NAME` | 测试：仓库根常驻 **`.env.test`**（模板 [`.env.test.example`](../../../.env.test.example)）；生产：`npm run deploy -- prod` → `collect-prod-env` 写临时 **`.env.prod`**（exit 删除） |

- **禁止**裸跑 `s deploy`：会明文打印 `environmentVariables`。
- 部署只用 [`scripts/deploy.ts`](scripts/deploy.ts) / [`scripts/deploy.sh`](scripts/deploy.sh) 薄包装（`--env-file`；内部 `s deploy` 输出丢弃）。
- **不再**常驻 `.env.fc.test` / `.env.fc.prod`。
- 真实 `*.fcapp.run` **禁止进 git**；只粘到浏览器「API 加速地址」。
- 轮换**测试**库密码 + Token：`npm run secrets:rotate-test`（只改 `.env.test`），然后可选 `npm run deploy -- test`。
- 刷新**生产**密钥：见下文「顶层 deploy」。

### Provider 无 stdin

`deploy.ts` **只读** `--env-file`（或 `ENV_FILE`）：校验必填键 + `FC_FUNCTION_NAME`，用临时 `s.yaml` overlay 覆盖函数名后部署；**不**询问通知渠道。顶层 `deploy` 在密钥已由 collect 校验后设 `DT_SKIP_NOTIFY_PROMPT=1`。

## 顶层 deploy（推荐）

见 [`docs/20260802-faas-multi-cloud.md`](../../../docs/20260802-faas-multi-cloud.md) §4：

```bash
# 仓库根
npm run deploy -- test    # .env.test；跳过 Vercel；问 FC/SCF
npm run deploy -- prod    # 先问 Vercel/FC/SCF（默认 N）；任一 Y 才 collect
```

`prod` 流程摘要：

1. `Deploy Vercel production?` / `Deploy Aliyun FC?` / `Deploy Tencent SCF?`（均默认 N）；全 N → 退出
2. 任一 Y → 子过程 `collect-prod-env`：stdin 收集 DB/Token/`FC_FUNCTION_NAME`/`SCF_FUNCTION_NAME`；Telegram/QQ 各自先问 Enable（N→写空）；Y 且根 `.env.test` 存在时再问是否复用该 bot 对应键（可手输）→ 写 `.env.prod`（0600）
3. 仅对选中的目标：Vercel upsert + `deploy --prod`；和/或 `fc:deploy` / `scf:deploy -- --env-file .env.prod`（各云 CLI 预检仅在对应 Y 之后）
4. exit / SIGINT：**删除** `.env.prod` 与部署临时 overlay

```bash
vercel login && vercel link   # 若本轮要部署 Vercel
s config get -a dt            # 若本轮要部署 FC
npm run deploy -- prod
```

## 测试 → 部署一条龙（test）

前置：已开通函数计算；`s config get -a dt` 可用；测试库已 `npm run db:migrate`；根 `.env.test` 已填（含 `FC_FUNCTION_NAME`）。

```bash
cd faas && go test ./...

# 仓库根：可选部署 FC
npm run deploy -- test
# 或：npm run fc:deploy -- --env-file .env.test

# 冒烟（Token 来自 .env.test，勿贴进聊天）
set -a && source .env.test && set +a
curl -s -H "Authorization: Bearer $DIGITAL_TWIN_TOKEN" \
  "https://<your-fcapp.run>/api/query/summary?tz=Asia/Shanghai"
```

改规格只改 [`s.yaml`](s.yaml)，再部署。当前默认**省钱档**。`pre-deploy` 在 `faas/` 编译 `bootstrap`。

## 加了新 API 之后怎么更新 FC

1. 在 `faas/` 实现路由 + `go test`
2. `npm run fc:deploy -- --env-file .env.test`（或 `deploy -- test`）
3. curl / 网页加速地址验证  
生产：`npm run deploy -- prod` 并在提示时选 **Y** 部署 FC。

## 本目录文件

```text
providers/aliyun-fc/
  s.yaml             # FC3 资源与规格（functionName 占位；deploy 用 overlay 覆盖）
  env.yaml           # 可选历史 overlays（手动 s --env）；日常走 --env-file
  scripts/deploy.ts  # 唯一允许的部署入口（--env-file）
  scripts/deploy.sh  # 薄包装
  scripts/info.sh    # 可选：s info --env（手工）
```

密钥键名见仓库根 [`.env.test.example`](../../../.env.test.example)（含 `FC_FUNCTION_NAME`）。
