# providers/tencent-scf — 腾讯云 SCF Web（国内加速）

与 [`../aliyun-fc`](../aliyun-fc) **永久并行**：共享 [`../../cmd/api`](../../cmd/api) Go HTTP；本目录只放 SCF 部署壳。

## 工具

```bash
npm i -g serverless-cloud-framework   # CLI 简写 scf
```

文档：[快速部署函数模板](https://cloud.tencent.com/document/product/1154/50938)

## 登录（一次）

必须在**本目录**（含 `serverless.yml`）执行：

```bash
cd faas/providers/tencent-scf
./scripts/login.sh
# 或: scf login
```

终端会出现 **https://slslogin.qcloud.com/…** 链接（或微信二维码）。用浏览器/微信完成授权后，凭证落在本机（**勿提交 git**）。

## 部署

```bash
cp env.scf.example .env.scf.test   # 填密钥（DATABASE_URL 含 & 时请用单引号包裹整段）
# 共享测试库须已迁移，否则鉴权过了也会对 /api/query 返回 500：
#   set -a && source .env.scf.test && set +a && cd ../../.. && npm run db:migrate
npx tsx scripts/deploy.ts test     # 或 ./scripts/deploy.sh test
./scripts/info.sh test             # 查看 URL → 粘贴到 Settings「API Accelerate URL」
```

`prod` 同理（`.env.scf.prod`）。`npm run secrets:refresh-prod` 中「Deploy Tencent SCF prod?」选 Y 时走同一套（实现接线后）。

### 密钥如何进运行时（勿写进 serverless.yml）

`serverless.yml` 的 `environment.variables` **只保留** `PORT=9000`。把 `DATABASE_URL` / Token 等写进 YAML 时，含 `&` 等特殊字符的连接串会导致平台侧异常（实测 HTTP 501）。

正确路径：

1. `deploy.ts` 把 `.env.scf.<env>` **原样拷贝**到 `.scf-build/.env`（与 `bootstrap`、`scf_bootstrap` 同包上传）
2. Web 入口 `scf_bootstrap`：`set -a && source ./.env && set +a`，再 `exec ./bootstrap`
3. `.env*` / `.scf-build/` 均已 gitignore；真实 Function URL **禁止进 git**

## 规格

- 地域 **`ap-guangzhou`**
- Web 函数、**64MB**、超时 30s、**无 CLS**（不必开通日志集）
- **新建**函数：控制台先建无 CLS 的 Web 函数（CustomRuntime），再本目录 `scf deploy` 更新代码包；`scf deploy` 直接新建常因未开通 CLS 失败

## 当前试验函数

`serverless.yml` → `inputs.name: digitaltwin-api-test`（CustomRuntime Web）。冒烟：`Authorization: Bearer <DIGITAL_TWIN_TOKEN>` 访问 `/api/query?limit=1` 应 **200** JSON。
