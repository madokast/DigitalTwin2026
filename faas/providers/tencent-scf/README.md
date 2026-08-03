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

### COS 暂存 zip（预期行为）

`serverless.yml` 里 `src: ./.scf-build` 是本地目录。`scf deploy`（`serverless-components/tencent-scf`）会：

1. 把目录打成 zip；
2. 上传到 **默认 staging 桶**（未在 yml 里自定义 `src.bucket` 时）：`sls-cloudfunction-ap-guangzhou-code-<AppId>`（地域随 `inputs.region`）；
3. 对象键形如 `/scf_component_<rand>-<unix>.zip`（**每次部署新 key**）；
4. 部署成功后，SCF **已摄入**该包；COS 对象只是 **部署暂存**，不是函数长期运行时的代码仓。

**不会在每次 deploy 后立刻删旧 zip。** 本仓库 `deploy.ts` / SCF CLI **都不会**在部署成功后立即清理旧对象。组件在创建默认桶时通常会挂生命周期规则：对象约 **10 天**过期删除（见组件 `uploadCodeToCos`）。`scf deploy --help` **无**清理旧包开关；`scf remove` 也**不**连带删 COS。本仓库 `deploy.ts` 只清本地 `.scf-build/.env` / patched yml，不动云端对象。

**生命周期删掉旧 zip 之后，已成功部署的 SCF 函数仍应正常工作**——过期的是暂存对象，不是「删函数」或「掏空运行时代码」。勿与下列情况混淆：

- 删除 / 下线 **函数本身**（那才会停服务）；
- 在 **上传 / 部署进行中** 删掉正在使用的对象（可能让当次 deploy 失败）。

每次新 deploy 再上传一个新对象；更旧的对象靠生命周期过期即可。

早期阶段建议：

1. 控制台确认该桶已有「约 10 天删除」生命周期；没有则补一条（最省事）。
2. 若桶里堆积明显、或对象已超约 10 天仍在：在 [COS 控制台](https://console.cloud.tencent.com/cos) 对该桶做人工清理（可删已过期/明显陈旧的旧包，或等生命周期；**不要**在一次 deploy 尚未成功结束时删正在上传的对象）。
3. **不**在本仓库加自动删 COS 脚本（需密钥、误删风险高）；除非日后部署频率很高再考虑 opt-in dry-run 工具。

成本：Go 二进制 zip 通常数 MB 级；短期残留费用可忽略，主要是控制台杂乱。

## 冒烟

Bearer Token 调 `/api/db/probe` 或 `/api/query?limit=1`。测延迟用 `curl --noproxy '*'`（见 [`docs/20260802-db-probe-multi-cloud.md`](../../../docs/20260802-db-probe-multi-cloud.md)）。
