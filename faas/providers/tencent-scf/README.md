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
cp env.scf.example .env.scf.test   # 填密钥
npx tsx scripts/deploy.ts test     # 或 ./scripts/deploy.sh test
./scripts/info.sh test             # 查看 URL → 粘贴到 Settings「API Accelerate URL」
```

`prod` 同理（`.env.scf.prod`）。`npm run secrets:refresh-prod` 中「Deploy Tencent SCF prod?」选 Y 时走同一套（实现接线后）。

## 规格

- 地域默认 **`ap-guangzhou`**（`serverless.yml`）
- Web + `CustomRuntime`，`PORT=9000`，`memorySize: 64` 起步（部署后可再调）
- 真实 URL / `.env.scf.*` **禁止进 git**
