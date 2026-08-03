# DigitalTwin2026 开发日志

> 日期：2026-08-02（续至 2026-08-03）  
> 状态：多云 FaaS（FC + SCF）落地；deploy / collect 分离；SCF Web **Go1** 打包；prod 可选 drizzle migrate  
> 相关：[`docs/20260802-faas-multi-cloud.md`](20260802-faas-multi-cloud.md)、[`docs/20260802-db-probe-multi-cloud.md`](20260802-db-probe-multi-cloud.md)、[`faas/providers/aliyun-fc/README.md`](../faas/providers/aliyun-fc/README.md)、[`faas/providers/tencent-scf/README.md`](../faas/providers/tencent-scf/README.md)

## 0. 今日做成了什么（总览）

| 类别 | 已完成 |
|------|--------|
| 目录 | `fc/` → `faas/` + `providers/aliyun-fc/`；共享 Go **不得** import `providers/*` |
| 顶层 deploy | `npm run deploy -- test\|prod`：只分发、不收集；prod 先问 Vercel/FC/SCF（均 `[y/N]` **默认 N**），任一 Y 才 collect |
| collect | `scripts/collect-prod-env.ts` → 临时 `.env.prod`（0600）；exit 由 deploy 删除 |
| 常驻测试密钥 | 根 `.env.test`（模板 `.env.test.example`）；废弃常驻 `.env.fc.*` / provider `env.*.example` |
| Provider | FC/SCF `deploy.ts` **仅** `--env-file`；读 `FC_FUNCTION_NAME` / `SCF_FUNCTION_NAME`；无 stdin、无 test/prod 分支 |
| SCF | Web + **Go1** + `scf_bootstrap` → `./bootstrap`；patch `inputs.name`（无 `-t`）；CLI 输出**透传** |
| FC 输出 | `s deploy` 仍**丢弃** stdout/stderr（防 environmentVariables 泄露） |
| Bot | Enable → 可选复用 `.env.test` 对应键（非整文件拷贝）→ 手输 + probe |
| Migrate | DB URL 校验通过后 `Run drizzle-kit migrate? [y/N]`（默认 N；Y → `npm run db:migrate`） |
| 探针 / 延迟 | `POST /api/db/probe`；双云墙钟对比记入 [`20260802-db-probe-multi-cloud.md`](20260802-db-probe-multi-cloud.md) |
| 退役 | 旧 `secrets:refresh-prod` / `refresh-prod-env` **已删除**（由 deploy + collect 取代） |

**明确不做**：不为多云加「部署到云」的 CI；不改 Settings 契约（仍单条 Accelerate URL）；不改 `docs/20260802-todo-feature.md`。

---

## 1. 部署交互（当前真源）

### 1.1 `npm run deploy -- test`

1. 读常驻 `.env.test`（缺则退出）  
2. **跳过 Vercel**  
3. `Deploy Aliyun FC?` / `Deploy Tencent SCF?`（默认 N）  
4. 全 N → 退出；否则仅部署所选（各云 CLI 预检仅在对应 Y 之后）

### 1.2 `npm run deploy -- prod`

1. 先问 `Deploy Vercel production?` / FC / SCF（均默认 N）——**无「Vercel 必做」**  
2. 全 N → 退出（不 collect）  
3. 任一 Y → 子过程 `collect-prod-env` → 写 `.env.prod`  
4. 仅部署选中的目标；`exit` / `SIGINT` 删除 `.env.prod` 与登记的临时 env 文件

### 1.3 `collect-prod-env` 顺序

1. 必填：数据库连接串（校验连接）→ 可选 **`npm run db:migrate`**（默认 N）  
2. 必填：AI Token / Admin Token  
3. Telegram / QQ：各自 Enable（N→空）；Y 且 `.env.test` 存在时可选复用该 bot 键，否则手输 + probe  
4. `FC_FUNCTION_NAME` / `SCF_FUNCTION_NAME`（默认 `digitaltwin-api-prod`）  
5. 写根目录临时 `.env.prod`（mode 0600）

实现：`scripts/deploy.ts`、`scripts/collect-prod-env.ts`。

---

## 2. SCF Web（Go1）要点

| 项 | 约定 |
|----|------|
| 形态 | `type: web`；`runtime: **Go1**`（控制台 **Go 1**） |
| 启动 | 包内 `scf_bootstrap` 启动 `./bootstrap`（linux/amd64），`PORT=9000` |
| 勿用 | **CustomRuntime**（Web CreateFunction 拒）；勿用 Nodejs「冒充基座」 |
| 函数名 | env `SCF_FUNCTION_NAME` → deploy 临时改写 `serverless.yml` 的 `inputs.name`；CLI **无** `-t` 模板 |
| 密钥 | `--env-file` → `.scf-build/.env`（YAML environment 只留 `PORT`，避免连接串特殊字符触发 501） |
| CLI 输出 | **透传**（SCF CLI 不打印密钥）；对比：FC `s deploy` **必须丢弃** |
| COS 暂存 | 每次 deploy 新 zip 到默认桶；约 10 天生命周期；**删旧 zip ≠ 停函数**（仅暂存，成功后 SCF 已摄入） |
| 地域 / 规格 | 默认 `ap-guangzhou`；约 64MB；能关 CLS 则关 |

详情：[`faas/providers/tencent-scf/README.md`](../faas/providers/tencent-scf/README.md)。

---

## 3. 与旧脚本的差异（避免文档回潮）

| 旧 | 现 |
|----|-----|
| `secrets:refresh-prod` 启动即偏强制 Vercel / 有时强制 `s` | 三云均默认 N；先问再 collect / 预检 |
| Provider 感知 test/prod、stdin 问 bot | Provider 只 `--env-file` |
| 常驻 / 临时 `.env.fc.*`、`.env.scf.*` | 根 `.env.test` + 临时 `.env.prod` |
| SCF 曾试 CustomRuntime / Node 绕路 | **Go1** + `scf_bootstrap` |

历史记述仍保留在 [`20260731-development-log.md`](20260731-development-log.md) / [`20260801-development-log.md`](20260801-development-log.md)；以本篇与 multi-cloud 文档为准。

---

## 4. 客户端

- Settings → **API Accelerate URL**：粘贴 **FC 或 SCF** 任一 Base URL；空 = 同源 Vercel。  
- **禁止**把真实加速 URL / 密钥提交进 git。

---

## 5. 验证（本批相关）

- 脚本单元：`scripts/deploy.test.ts` 等（默认 N、`--env-file`、函数名 overlay、migrate decision）  
- `cd faas && go test ./...`（无 DB 时集成 Skip）  
- 手工：`npm run deploy -- test|prod` 选单云；SCF Base URL 冒烟（Bearer + `/api/db/probe` 等）  
- 延迟对比：见 [`20260802-db-probe-multi-cloud.md`](20260802-db-probe-multi-cloud.md)（含清代理后结论）

---

## 6. 今日提交（主题块，自新到旧节选）

```
ac204d3  Offer optional drizzle migrate after prod DATABASE_URL verification
f15bd06  Fix prod deploy UX and SCF Go1 packaging; optional Vercel; bot keys from .env.test
03cb400  Remove deprecated secrets:refresh-prod stubs and redundant env examples
a669bc7  Document .env.test, temporary .env.prod, and deploy/collect roles
3fc1e9a  Make FC/SCF deploy env-file only with function-name overlays
aa469ac  Add deploy/collect split and retire secrets:refresh-prod
b35b4ab  Switch local runtime to permanent .env.test via shared loader
83be59f  Ship SCF secrets via code-package .env to avoid YAML 501 on DATABASE_URL
38d1e71 / 1185d8d / 2e6864d  Docs: FC vs SCF latency (probe + summary；清代理)
a07c1f2  Add POST /api/db/probe for short-lived Postgres latency checks
d2efdd7  Add Tencent SCF Web provider scaffold with scf login flow
```

完整列表以 `git log --since=2026-08-02` 为准。

---

## 7. 仍待办 / 开放

- [ ] 手动验收清单续跑；用户确认 SCF 内存档是否可再降  
- [ ] （可选）Settings placeholder 补 SCF 域名示例  
- [ ] Dashboard 支出组件 / 网页录入 UI（与多云无关，沿自既有待办）
