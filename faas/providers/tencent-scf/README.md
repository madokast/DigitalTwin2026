# providers/tencent-scf — 腾讯云 SCF Web（国内加速）

与 [`../aliyun-fc`](../aliyun-fc) **永久并行**：共享 [`../../cmd/api`](../../cmd/api) Go HTTP；本目录只放 SCF 部署壳。

## 工具

```bash
npm i -g serverless-cloud-framework   # CLI 简写 scf
```

文档：[快速部署函数模板](https://cloud.tencent.com/document/product/1154/50938)

## 登录（一次）

```bash
cd faas/providers/tencent-scf
./scripts/login.sh
# 或仓库根: npm run scf:login
```

## 函数名

由 env 文件中的 **`SCF_FUNCTION_NAME`** 决定（deploy 临时改写 `serverless.yml` 的 `inputs.name`）。常用：`digitaltwin-api-test` / `digitaltwin-api-prod`。

CLI banner 里的 **Name** 是组件实例名（固定 `digitaltwin-api`），**不是**云函数名；云函数名看 `functionName` / `SCF_FUNCTION_NAME`。

## Runtime（重要）

| 项 | 值 |
|----|-----|
| `type` | `web` |
| `runtime` | **`Go1`**（控制台标签 **「Go 1」**；[CreateFunction](https://cloud.tencent.com/document/product/583/18586) 合法值） |
| 启动 | 包内 **`scf_bootstrap`** → `./bootstrap`（Go linux/amd64），监听 **9000** |

Web + Go 是官方支持路径（[Golang 部署方法](https://cloud.tencent.com/document/product/583/67385)）：zip 里放编译好的二进制 + `scf_bootstrap`，**不是**事件函数那套 `scf-go-lib` Handler。

勿用 **`CustomRuntime`**：对 Web `CreateFunction` 会报 `runtime参数错误或者该操作暂不支持该runtime`。也不要用 Nodejs「冒充基座」——那是错误绕路。

控制台若先建函数：选 **Web 函数**、运行环境 **Go 1**、地域 **`ap-guangzhou`**、名称与 `SCF_FUNCTION_NAME` 一致、约 **64MB**；能关 **CLS** 则关。也可不预建，由 `scf deploy` 直接创建。

## 密钥来源（重要）

| 场景 | 密钥从哪来 | 落盘 |
|------|------------|------|
| 任意部署 | **仅** `--env-file <path>`（或 `ENV_FILE`） | 内容拷进 `.scf-build/.env` → **exit 删除**；临时 patched `serverless.yml` 同会话还原 |
| 推荐入口 | `npm run deploy -- test`（`.env.test`）或 `deploy -- prod`（临时 `.env.prod`） | 同上 |

Provider **无 stdin**、**无 test/prod 分支**。YAML `environment` 只留 `PORT`（避免 DATABASE_URL 特殊字符触发 501）。

## 部署

```bash
# 推荐：仓库根 orchestrator
npm run deploy -- test
npm run deploy -- prod    # Deploy Vercel? → N；Deploy Aliyun FC? → N；Deploy Tencent SCF? → Y

# 薄包装
npm run scf:deploy -- --env-file .env.test
```

密钥经 `--env-file` → `.scf-build/.env`；`scf deploy` **不**明文打印密钥，CLI stdout/stderr **透传**到终端（与阿里云 FC `s deploy` 必须丢弃输出不同）。

> SCF CLI **没有** Aliyun `s deploy -t <file>` 那种模板路径；本脚本用「备份 → 写入 patched `serverless.yml` → deploy → 还原」覆盖函数名。

## 冒烟

Bearer Token 调 `/api/db/probe` 或 `/api/query?limit=1`。测延迟用 `curl --noproxy '*'`（见 [`docs/20260802-db-probe-multi-cloud.md`](../../../docs/20260802-db-probe-multi-cloud.md)）。
