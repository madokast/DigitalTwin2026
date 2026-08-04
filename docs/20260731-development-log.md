# DigitalTwin2026 开发日志

> **2026-08-04 变更提示**：`value_text` / `value_number` 已全量更名为 `raw_content` / `numeric_value`，todo 审计行存储语义亦已变更（本文正文保留当时原样）。详见 [`20260804-rename-value-text-to-raw-content.md`](20260804-rename-value-text-to-raw-content.md)。

> 日期：2026-07-31
> 状态：Admin 编辑 + FC 部署收尾；Telegram 通知；OpenAPI 契约基建完成并**收口**（不做 codegen / Schemathesis）；仓库公开后 CI 全绿

## 0. 今日做成了什么（总览）

上半日：补齐 **Admin 就地改记录**、落地 **阿里云 FC**、收紧浏览器鉴权与语言原则。  
下半日：录入 **Telegram 通知**、脚本迁 TypeScript、落地并收口 **OpenAPI 3.1 契约**（多文件 + lint + fixtures 契约测 + CI），并明确产品下一步不再扩 OpenAPI 工具链。

| 类别 | 已完成 |
|------|--------|
| Admin API | `PATCH /api/admin/records/[id]`；proxy 仅 Admin Token |
| 校验 | `src/lib/record-draft.ts` 前后端共用；单元 + 路由集成测试 |
| 详情 UI | 双击编辑草稿；脏数据才显示提交；成功 refetch；失败展示 error |
| Null | `NullBadge`：斜体淡色、不可选中；真实 `'-'` / `''` 原样 |
| 标签 | 无逗号独立 chip；编辑仅显隐 `×` / `+`；修复占位塌缩导致的文字跳动 |
| Go API | `faas/`：`go run ./cmd/api`，路由 + CORS + 鉴权对齐；`go test ./...` |
| FC 部署 | `s.yaml` / `env.yaml`；`scripts/deploy`（禁裸 `s deploy`）；`info.sh`；省钱规格 |
| 设置加速 | prefs `apiAccelerateBase` → UI **API Accelerate URL**；空=同源 Vercel |
| 密钥脚本 | `secrets:rotate-test`；`secrets:refresh-prod`（Vercel prod + FC prod；TS 实现） |
| Vercel | `.vercelignore` 排除整个 `faas/`，避免 bootstrap 撑大上传 |
| 浏览器 Token | 前端只认 Admin Token（`digitaltwin_admin_token`）；服务端仍双 Token |
| 语言 | 用户可见英文；注释/文档中文；原则写入 `AGENTS.md` |
| Telegram | `POST /api/log/*` 成功后 best-effort 通知；`POST /api/telegram/probe`；测试模式可跳过实发 |
| OpenAPI | 3.1 多文件 `$ref`；Redocly；fixtures + Vitest / Go contract；CI；**已收口** |
| 契约对齐 | `value_number` 仅十进制字符串；`happened_at` / `from`/`to` 必带时区；输出 `…sssZ` |
| 文档 | `faas/providers/aliyun-fc/README.md`、`openapi/README.md` 真源；根 README / `AGENTS.md` 同步；本日志 |

## 1. Admin PATCH

- 路径：`PATCH /api/admin/records/[id]`
- Body：可编辑字段快照（`happened_at`、`value_number`、`value_text`、`tags`、`objective_context`、`subjective_interpretation`）
- 规则要点：
  - 空串 → `null`（`objective_context` 除外，不允许空）
  - `value_number` / `value_text` 不能同时为空
  - `tags` 非空且每项 `isValidTag`
  - `happened_at` 必填且带时区偏移
- 前端提交时间：人只选墙钟（`datetime-local`），提交时用 `resolveTimezone()` 拼偏移（与 Dashboard / query 一致）

相关：`src/app/api/admin/records/[id]/route.ts`、`src/lib/record-draft.ts`、`src/lib/api-client.ts`。

## 2. 详情页双击编辑

- 有 Admin Token：双击可编辑区进入草稿态
- 无 Admin：双击提示无编辑权限，不进入编辑
- 硬约束：**零重排**——尽量不因换成控件而改变字号、边距、块尺寸
- 字段交互：
  - 时间：日期时间选择器（无时区控件）
  - 数值：光标 + 默认全选
  - 文本 / 客观 / 主观：contentEditable；Null 从空串起编
  - 标签：chip 行内删 / `+` 搜选或回车新建
- 仅草稿相对服务端有差异时显示提交按钮；成功后 refetch 并退出编辑态

相关：`src/app/records/[id]/page.tsx`、`src/components/null-badge.tsx`、`src/components/record-tag-chips.tsx`、`src/lib/datetime-ui.ts`。

## 3. 标签 chip 布局修正

现象：只读 → 编辑时标签文字向左跳。

原因：每个 chip 曾用左侧 `invisible` × + 右侧 ×；进入编辑后左侧改为 `hidden`，占位塌缩。

修正：去掉左侧对称占位；只保留右侧固定宽 `×` 与末尾 `+`，只读用 `invisible` 占位、编辑可见，**不用 `hidden`**，盒模型宽度切换前后一致。

## 4. Go API + FC 部署

### 4.1 本地 Go HTTP

- 目录：`faas/`（标准 `net/http`，不依赖阿里云 SDK 即可本地跑）
- 路由与鉴权对齐 Next：`/api/log/*`、`/api/query*`、`/api/admin/*`
- pgx：`QueryExecModeCacheDescribe`（适配 Neon pooler）
- 设置页 **API Accelerate URL**：本机 prefs；**不用** `NEXT_PUBLIC_*`；真实 FC URL **不进 git**

```bash
cd faas && export $(grep -v '^#' ../.env.test | xargs) && go run ./cmd/api
# Settings → API Accelerate URL = http://localhost:8080
cd faas && go test ./...
```

### 4.2 Serverless Devs

- `faas/providers/aliyun-fc/s.yaml` + `env.yaml`（test / prod 函数名；overlay 写在 `overlays.resources.api` 下，勿再包 `props:`）
- 部署：**必须** `npm run fc:deploy -- --env-file <path>`（禁裸 `s deploy`，防密钥进终端）
- 取 URL：见 [`faas/providers/aliyun-fc/README.md`](../faas/providers/aliyun-fc/README.md)
- 省钱默认：128MB / 0.05 CPU / disk 512 / timeout 30 / `instanceConcurrency: 1` / `minInstances: 0` / `reservedConcurrency: 1`
- 操作说明只维护在 **[`faas/providers/aliyun-fc/README.md`](../faas/providers/aliyun-fc/README.md)**；`AGENTS.md` 仅引用

### 4.3 密钥与 Vercel

- `npm run secrets:rotate-test`：轮换测试库密码 + 两 Token；更新 `.env.test`
- `npm run secrets:refresh-prod`：交互刷新生产 `DATABASE_URL` / Token → Vercel production + 临时 `.env.prod` 部署后删除 → `vercel deploy --prod`
- `.vercelignore` 排除 `faas/` 等，避免本地 `bootstrap` 把上传体积撑到几十 MB
- Vitest `tests/setup.ts`：以 `.env.test` override 加载，避免 shell 残留旧密钥

实测：配置加速后国内浏览器 API 约 **200–400ms**（仍受 FC→Neon 跨境影响，可接受）。

## 5. 前端只认 Admin Token

- 设置页仅 **Admin Token** → `localStorage` `digitaltwin_admin_token`
- 去掉浏览器侧 `getToken` / `digitaltwin_token`；`api-client` 一律 `getAdminToken()`
- **服务端仍双 Token**：`DIGITAL_TWIN_TOKEN` 给 AI；`DIGITAL_TWIN_ADMIN_TOKEN` 给网页（普通 API 二者皆可，`/api/admin/*` 仅 Admin）

## 6. 语言原则

写入 `AGENTS.md`：

- 用户可见文案一律英文（UI、错误、日志、脚本输出、API `error`、aria-label 等）
- 仅代码注释与文档用中文
- 测试里故意使用的非 ASCII 非法 tag 样例除外

## 7. Telegram 通知

- `POST /api/log/number`、`POST /api/log/text` 入库成功后 **best-effort** 发 Telegram（失败不影响 201）
- `POST /api/telegram/probe`：严格探测发送（env 未配 / Bot API 失败分别 400 / 502）
- 测试：（历史）`DIGITAL_TWIN_TEST=1` 跳过 insert 路径实发；单测曾用 `TELEGRAM_ALLOW_IN_TEST=1` + mock。**现行**静音见 [`20260803-suppress-bot-notification.md`](20260803-suppress-bot-notification.md)（`SUPPRESS_BOT_NOTIFICATION`；probe 不受约束）
- 密钥：`TELEGRAM_BOT_TOKEN` / `TELEGRAM_USER_ID`；test/prod 可共用同一 Bot

相关：`src/lib/telegram.ts`、双端 log / probe 路由、OpenAPI `telegram` tag。

## 8. 脚本迁 TypeScript

- `scripts/refresh-prod-env.ts`、`faas/providers/aliyun-fc/scripts/deploy.ts`；薄 `.sh` 包装
- 交互：跳过 / 空值 UX；连通性检查仅在未 skip 时跑
- 根 README：env 细节指向 `.env.test.example`；接口表让位给 OpenAPI

## 9. OpenAPI 契约（已收口）

### 9.1 落地内容

| 项 | 说明 |
|----|------|
| 文档 | Design-first OpenAPI 3.1；入口 `openapi/openapi.yaml` |
| 模块 | `paths/`（log / query / telegram / admin）+ `components/`；kin-openapi 需按名 `$ref` + `IsExternalRefsAllowed` |
| Lint / 预览 | `npm run openapi:lint`（Redocly）；`npm run openapi:preview` → `redoc-static.html` |
| 契约测 | `openapi/fixtures/`；Vitest Ajv；Go `faas/internal/contract` |
| CI | `.github/workflows/ci.yml`（lint + 双端契约测；不含需 DB 集成测） |

### 9.2 与实现对齐的硬约束

- 请求 `happened_at`、query `from`/`to`：必须带时区（`Z` / `±HH:MM`）
- `Record.happenedAt` 输出：UTC `YYYY-MM-DDTHH:mm:ss.sssZ`
- `value_number` / `valueNumber`：仅十进制**字符串**或 null；JSON number → 400；DB 列为 TEXT（migration `0000`；可接受 drop/recreate）
- schema `pattern`：`HappenedAtInput` / `HappenedAtUtcZ` / `DecimalString` / `TagName`

### 9.3 定死边界（勿再提案）

写入 [`openapi/README.md`](../openapi/README.md)「开发边界」：

- **不做** codegen（类型 / stub / SDK）
- **不做** Schemathesis（及同类实网模糊测）
- **不设** Phase 3 / 额外 OpenAPI 工具链
- 以后只在**改 API** 时维护 YAML + fixtures + 双端手写 + 现有测

讨论过、**本仓不做**的旁路：前端纯静态 / GitHub Pages（另仓另议；继续 Vercel Next + Accelerate）。

### 9.4 CI 插曲

- 仓库公开后首次 Actions：Go 契约测绿；Node 死在 `npm ci`（lockfile 缺 vitest 树下 `esbuild@0.28.1`；本地 npm 11 宽松、CI npm 10 严格）
- 修复：用 npm 10 + `registry.npmjs.org` 重生 `package-lock.json`
- `320e4a5` 起 CI 全绿（Node lint/契约 + Go contract）

## 10. 今日提交（节选）

```
c862052 收口 OpenAPI：定死开发边界，明确不做 codegen 与 Schemathesis。
320e4a5 拆分 OpenAPI 为多文件模块，并修复 package-lock 以兼容 CI npm 10。
57ca449 完善 OpenAPI Phase 2：契约测、Redocly CI、pattern 与预览。
6171831 对齐 value_number 十进制字符串与 happened_at 时区契约，并在测试模式跳过 Telegram。
bb61cc5 落地 OpenAPI Phase 1 契约，并显式对齐 Record.happenedAt 为 UTC Z。
3d1471f 添加录入 Telegram 通知，并将生产刷新/FC 部署脚本迁到 TypeScript。
8c5cccc 用户可见文案统一为英文，并在 AGENTS 写入语言原则。
c5f14cf 前端只认 Admin Token：去掉浏览器侧普通 Token 槽位。
a09bdb9 添加生产密钥刷新脚本，并排除 FC 产物以免撑大 Vercel 上传。
1132007 完善 FC 文档与省钱规格：faas/providers/aliyun-fc/README 为操作真源，AGENTS 仅引用。
7090104 测试 setup 以 .env override 加载，避免 shell 旧密钥覆盖。
0629231 添加 FC Serverless Devs 部署骨架与测试密钥轮换脚本。
070ae6f 实现阿里云 FC 第一期子集：设置页 API 加速地址与本地可跑 Go HTTP API。
50507eb 修复标签 chip 双击编辑时左侧 × 占位塌缩导致文字跳动。
6a63995 实现记录详情双击编辑：零重排草稿与标签 chip。
f117da6 添加 Admin PATCH 更新记录接口与草稿校验。
```

## 11. 仍待办（产品向；OpenAPI 基建已结束）

优先建议回到业务，而不是契约工具：

- [ ] 专用录入接口（账单、体重、复盘等）
- [ ] 账单汇总（transaction summary；路径待定）
- [ ] Dashboard 其它组件（体重/支出等）
- [ ] 前端：记录删除 / 图表 / 列表行内编辑
- [ ] AI 侧 CLI 包装（只注入 AI Token）
- [ ] 数据库 COMMENT、数据导出
- [x] 阿里云函数计算部署（日常以 `faas/providers/aliyun-fc/README.md` 为准）
- [x] OpenAPI 契约基建（见 §9；维护即可）

可选运维（非代码必做）：Vercel Hobby 防火墙限流 1 条；Token 轮换习惯；公开站主要风险是额度刷停而非自动扣费。
