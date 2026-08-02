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

由 env 文件中的 **`SCF_FUNCTION_NAME`** 决定（覆盖 `serverless.yml` 占位）。常用：`digitaltwin-api-test` / `digitaltwin-api-prod`。

控制台先建对应 **无 CLS** Web 函数（CustomRuntime、`ap-guangzhou`、64MB），再部署。

## 密钥来源（重要）

| 场景 | 密钥从哪来 | 落盘 |
|------|------------|------|
| 任意部署 | **仅** `--env-file <path>`（或 `ENV_FILE`） | 内容拷进 `.scf-build/.env` → **exit 删除**；临时 serverless overlay 同删 |
| 推荐入口 | `npm run deploy -- test`（`.env.test`）或 `deploy -- prod`（临时 `.env.prod`） | 同上 |

Provider **无 stdin**、**无 test/prod 分支**。YAML `environment` 只留 `PORT`（避免 DATABASE_URL 特殊字符触发 501）。

## 部署

```bash
# 推荐：仓库根 orchestrator
npm run deploy -- test
npm run deploy -- prod    # Deploy Tencent SCF? → Y

# 薄包装
npm run scf:deploy -- --env-file .env.test
```

## 冒烟

Bearer Token 调 `/api/db/probe` 或 `/api/query?limit=1`。测延迟用 `curl --noproxy '*'`（见 [`docs/20260802-db-probe-multi-cloud.md`](../../../docs/20260802-db-probe-multi-cloud.md)）。
