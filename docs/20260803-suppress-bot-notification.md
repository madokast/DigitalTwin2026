# DigitalTwin2026：用 `SUPPRESS_BOT_NOTIFICATION` 替代请求体 suppress 与模糊测试 env

> 创建日期：2026-08-03  
> 状态：**已落地**（阶段 1–4 全部完成：门闸换键 + deploy 强制注入 + 删 body `suppress_notification` + 文档收尾）  
> 性质：Diataxis **explanation** + how-it-works；实现阶段见 **§10**  

> 相关：[`docs/20260801-api-layering.md`](20260801-api-layering.md) §7、[`docs/20260802-todo-feature.md`](20260802-todo-feature.md)、[`docs/20260803-records-import-export.md`](20260803-records-import-export.md)、[`faas/README.md`](../faas/README.md)、[`.env.test.example`](../.env.test.example)

## 0. 一句话结论

业务 API 成功路径**一律** `schedule` → `notify_user` / `NotifyUser`；是否真发 bot 只看进程环境变量 **`SUPPRESS_BOT_NOTIFICATION` 是否存在且 trim 后严格等于 `'1'`**。删除请求体 `suppress_notification`，删除 `DIGITAL_TWIN_TEST` 与 `NOTIFY_ALLOW_IN_TEST`。

**Probe 例外（摘要）：** `SUPPRESS_BOT_NOTIFICATION=1` 只静音业务自动 notify；`POST /api/telegram/probe` / `POST /api/qqbot/probe` **不受约束**，仍走真实渠道；测试里偶尔跑 probe 真发可接受（次数少、可控）。

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 |
|---|------|
| 1 | 客户端 / AI **无法**用 body 静默跳过通知。 |
| 2 | 测试与 `deploy -- test` 云函数**明确不**走真实 bot 扇出（避免集成测 / 冒烟爆炸）。 |
| 3 | **`deploy` 自动注入**该变量（用户透明，不问、不手填）：`deploy -- test` → `=1`；`deploy -- prod`（Vercel / FC / SCF）→ `=0`。 |
| 4 | **probe**（Telegram / QQ）仍能真发，用于验渠道。 |
| 5 | 去掉模糊总开关 `DIGITAL_TWIN_TEST` 与暗示「默认静默」的 `NOTIFY_ALLOW_IN_TEST`。 |

### 1.2 非目标

- 本篇不改代码、不 commit。
- 不改变「成功后 best-effort、不阻塞写响应」语义（Next `after()` / Go `go`）。
- 不把 channel 配置探测（`configError`）并入 suppress 门闸。
- 不引入第二个「测试总开关」或 `ALLOW_*_IN_TEST` 命名。

---

## 2. 摸底：现状如何跳过通知

### 2.1 两层门闸（现状）

```text
HTTP 成功
  └─ handler: if !suppress_notification → schedule notify
       └─ notify_user / NotifyUser
            └─ shouldSkipNotifyInTest / ShouldSkipNotifyInTest
                 ├─ NOTIFY_ALLOW_IN_TEST trim=='1' → 不跳过（放行）
                 └─ else DIGITAL_TWIN_TEST trim=='1' → 跳过
                      └─ 否则并行 Telegram / QQ
```

| 层 | 机制 | 位置（摘要） |
|----|------|----------------|
| **请求体** | `suppress_notification: true` → handler 不 schedule | OpenAPI schemas；Next `readSuppressNotification`；Go `notify.ReadSuppressNotification`；六个写路径 draft 允许键 |
| **进程 env** | `DIGITAL_TWIN_TEST=1` 且无 `NOTIFY_ALLOW_IN_TEST=1` → `notify_user` 直接 return | `src/lib/notify.ts`；`faas/internal/notify/notify.go` |

probe（`POST /api/telegram/probe`、`POST /api/qqbot/probe`）走各渠道 `sendTelegramMessage` / `SendMessage`，**不**经 `notify_user`，故**不受**上述 env 门闸影响（现状已如此）。

### 2.2 `suppress_notification` 影响面（简表）

| 区域 | 路径 / 符号 |
|------|-------------|
| OpenAPI | `openapi/paths/log.yaml`；`openapi/components/schemas.yaml`（多请求 schema）；fixtures 含该键 |
| Next drafts | `logapi` / `transactiondraft` / `bodyweightdraft` / `tododraft` |
| Next handlers | `log/numbers|text|transactions|body/weight|todo|todo/transition` |
| Go drafts | `logapi` / `transactiondraft` / `bodyweightdraft` / `tododraft` |
| Go HTTP | `faas/internal/httpx/server.go` 各 log handler |
| 共享 helper | `src/lib/suppress-notification.ts`；`faas/internal/notify/suppress.go` |
| 测试 | route / contract / httpx / integration 等大量断言 |

实现时整段删除；成功路径改为**无条件** schedule（与 [`docs/20260803-records-import-export.md`](20260803-records-import-export.md)「一律 Notify」对齐）。

### 2.3 `DIGITAL_TWIN_TEST` 全引用与用途

**结论：无其它功能，可整删。** 仓库内（含 docs / scripts / tests / faas / src / CI 叙述）全部代码用途都是「给 `notify_user` 跳过当总开关」；文档叙述同义。**不做拆分旁路**——不要把该模糊总开关拆成多个隐式 flag；直接换成唯一显式键 `SUPPRESS_BOT_NOTIFICATION` 后整删 `DIGITAL_TWIN_TEST`。（已整删，阶段 1 落地。）

| 位置 | 当前行为 | 拆分后替代 |
|------|----------|------------|
| `src/lib/notify.ts` `shouldSkipNotifyInTest` | `DIGITAL_TWIN_TEST=='1'` 则跳过（可被 ALLOW 覆盖） | 改为读 `SUPPRESS_BOT_NOTIFICATION`；建议改名 `shouldSuppressBotNotification` |
| `faas/internal/notify/notify.go` `ShouldSkipNotifyInTest` | 同上 | 同上 → `ShouldSuppressBotNotification` |
| `tests/setup.ts` | Vitest 全局设 `=1`，并 `delete NOTIFY_ALLOW_IN_TEST` | 设 `SUPPRESS_BOT_NOTIFICATION=1`；删 ALLOW 相关 |
| `scripts/test-integration.ts` | `DIGITAL_TWIN_TEST ??= '1'` | `SUPPRESS_BOT_NOTIFICATION ??= '1'`（或依赖 `.env.test` 已写死） |
| `faas/internal/httpx/main_test.go` TestMain | 设 `=1`，Unset ALLOW | 设 `SUPPRESS_BOT_NOTIFICATION=1` |
| `faas/internal/telegram/main_test.go` TestMain | 设 `=1`（telegram 包本身不读该变量；防御性） | **删除**该 TestMain 设置即可；或改为设 `SUPPRESS`（无实际效果于 SendMessage） |
| `faas/internal/notify/notify_test.go` | TestMain + 用例注入 | 改测 `SUPPRESS_BOT_NOTIFICATION`；放行用例改为「未设 / 非 `'1'`」+ mock fetch，**不**再引入 ALLOW |
| `src/lib/notify.test.ts` | 同上 | 同上 |
| `faas/internal/httpx/integration_test.go` 注释 | 称 DIGITAL_TWIN_TEST 双保险；另清空渠道 Getenv | 注释改指 `SUPPRESS`；清空渠道可保留 |
| `.env.test.example` | 仅注释提 ALLOW / DIGITAL_TWIN_TEST | 写入 `SUPPRESS_BOT_NOTIFICATION=1` |
| `faas/README.md`、`openapi/README.md`、发展日志 | 文档叙述 | **实现时同步**一句 pointer（本篇为真源） |

**数据库安全门闸**（`assertSafeTestDatabaseUrl` / `AssertSafeTestDatabaseURL`）**独立**于 `DIGITAL_TWIN_TEST`，只认 `DATABASE_URL` host/库名含 `test` / `TestDigitalTwin`。**不要**把 DB 安全并进 notify 开关。

### 2.4 `NOTIFY_ALLOW_IN_TEST` 全引用

| 位置 | 角色 |
|------|------|
| `shouldSkipNotifyInTest` / `ShouldSkipNotifyInTest` | `=='1'` 时**强制放行** notify（覆盖 DIGITAL_TWIN_TEST） |
| `tests/setup.ts` | 默认 `delete`，防 shell 残留误放行 |
| Go TestMain（httpx / telegram / notify） | `Unsetenv` |
| `notify.test.ts` / `notify_test.go` | 单测要行使真实发送逻辑（配 mock fetch）时注入 `=1` |
| `.env.test.example`、`faas/README.md`、发展日志 | 说明「默认跳过，设 1 才允许」 |

**删除原因**：命名暗示「测试默认不 notify、需要特殊允许」；与「业务一律 schedule、仅 env 挡真实发送」相反。单测改走 §5（测试方案）。

### 2.5 deploy / collect 如何注入 env（摸底 + 锁定）

| 路径 | 行为（现状摸底） |
|------|------------------|
| `npm run deploy -- test` | 读常驻 **整文件** `.env.test`（`parseDotenvFile`），校验 runtime 必填后交给 FC/SCF 子脚本 |
| FC `faas/providers/aliyun-fc/scripts/deploy.ts` | **白名单**：REQUIRED（DB/Token/`FC_FUNCTION_NAME`）+ OPTIONAL（仅 Telegram/QQ 五键）→ 写入 `s.yaml` `environmentVariables`（经 `process.env` + `${env(...)}`） |
| SCF `faas/providers/tencent-scf/scripts/deploy.ts` | **同一白名单**（`SCF_FUNCTION_NAME`）→ 打进 `.scf-build/.env` |
| `npm run deploy -- prod` | `collect-prod-env` → 临时 `.env.prod`（`COLLECT_KEYS` 现无 suppress 类键）→ Vercel upsert `VERCEL_KEYS` / FC / SCF 同上白名单 |
| Vercel | `deploy -- test` **跳过**；prod 只 upsert 渠道与 Token 等（**现状白名单无** `SUPPRESS_BOT_NOTIFICATION`） |

**重要缺口（现状，已修复：阶段 2）**：FC/SCF（及 Vercel upsert）白名单**不包含** `DIGITAL_TWIN_TEST` / `NOTIFY_ALLOW_IN_TEST`（也尚未含 `SUPPRESS_BOT_NOTIFICATION`）。因此 **test 云函数若配置了 bot 密钥，当前会实发 notify**；本地 Vitest/Go TestMain 才跳过。→ 修复后：白名单一律放行该键，`deploy -- test` 强制 `=1`、`deploy -- prod` 强制 `=0`。

**锁定（实现时）：云上由 `deploy` 强制注入，用户透明（collect / 部署问答不问该键）：**

| `deploy` 模式 | 注入值 | 含义 |
|---------------|--------|------|
| `deploy -- test` | `SUPPRESS_BOT_NOTIFICATION=1` | 云上业务 `notify_user` 跳过 |
| `deploy -- prod`（Vercel / FC / SCF） | `SUPPRESS_BOT_NOTIFICATION=0` | 正常发（与「未设置」同效果；显式 `0` 更清晰，避免「变量不存在」歧义） |

要点：

1. **缺口修法**：FC/SCF（及 Vercel upsert）白名单**一律放行** `SUPPRESS_BOT_NOTIFICATION`（常驻包含该键）；test / prod **都注入**，**只是值不同**——test=`1`，prod=`0`。不要再按环境决定「白名单加不加键」。
2. **与 `.env.test` 的关系（本地显式化）**：本地 `.env.test` / `.env.test.example` **必须显式写** `SUPPRESS_BOT_NOTIFICATION=1`（一目了然，不靠 setup 偷偷设才「看起来有」）。setup / TestMain / `test-integration` 仍可双保险再设 `=1`。**云上以 deploy 注入为准**——即使用户文件漏写，`deploy -- test` 也**强制**写 `1`；`deploy -- prod` **强制**写 `0`（即使误从 test 文件带了 `1` 也要覆盖为 `0`）。
3. **collect-prod-env / 用户交互**：**不问**该键；脚本在生成 `.env.prod` 或 upsert / 打包时**自动追加** `SUPPRESS_BOT_NOTIFICATION=0`。
4. 必须可验证：test 云进程读到 `=1`，prod 云进程读到 `=0`。

---

## 3. 锁定决策：新门闸

### 3.0 `SUPPRESS_BOT_NOTIFICATION` 的意义

| | 说明 |
|--|------|
| **为什么存在** | 测试与 `deploy -- test` 会高频打业务写路径；若带真实 bot 密钥，自动 notify 会刷爆渠道。需要**一个进程级、意图清晰**的静音开关，而不是模糊的 `DIGITAL_TWIN_TEST`，也不是客户端可传的 body 开关。 |
| **管什么** | 仅压制经 `notify_user` / `NotifyUser` 的**业务成功路径自动 bot 通知**（录入 number/text/transaction/body/weight/todo、todo transition，以及未来一律 schedule 的写路径）。`=1` 时 handler 仍一律 schedule，但 `notify_user` 入口早退，**不打** Telegram/QQ。 |
| **不管什么** | HTTP 契约与写库成败；未配置渠道时的 no-op；**probe API**（见 §4）；DB 安全门闸（`assertSafeTestDatabaseUrl`）；鉴权。 |
| **命名** | Suppress Bot Notification——一眼可知只影响 bot 扇出，不是「进入测试宇宙」总开关。 |

**对比：进程级静音 vs 按请求关通知（已删 body）**

| | 旧：请求体 `suppress_notification` | 新：env `SUPPRESS_BOT_NOTIFICATION` |
|--|--------------------------------------|--------------------------------------|
| **作用域** | **单次请求**：body 为 `true` → 本请求不 schedule | **整进程**：所有业务 `notify_user` 早退 |
| **谁控制** | 客户端 / AI / 调用方 | 部署与运行环境（`.env.test`、setup、**deploy 注入**的云函数 / Vercel env） |
| **产品意图** | 调用方可选择关通知（已废弃） | 测试 / `deploy -- test` **强制** `=1` 业务静音；生产由 **`deploy -- prod` 写 `=0`** = 正常发 |
| **与「一律 schedule」** | 冲突（handler 可跳过 schedule） | **兼容**：仍一律 schedule；真发与否在 `notify_user` 内由 env 决定 |

一句话：**删掉的是「按请求关通知」；留下的是「按环境静音业务自动 bot」。**

### 3.1 语义（严格）

| `SUPPRESS_BOT_NOTIFICATION` | 行为 |
|-----------------------------|------|
| **不存在** / 未设置 | **发送**（若渠道已配置） |
| 存在但 trim 后为空 | **发送** |
| trim 后为 `'1'` | **跳过**真实 bot 发送（`notify_user` 早退） |
| trim 后为 `'0'` | **发送**（与「未设置」同效果；**prod 由 deploy 显式写 `0`**，避免「变量不存在」歧义） |
| 其它任何值（含 `'true'`、`'yes'`、`'1 '` 已 trim 后非严格等） | **发送**（仅 `'1'` 抑制） |

与现有 `envFlagOn`：`(value ?? '').trim() === '1'` 一致；实现时**只**换键名，**不要**放宽为 truthy。

注入优先于 `process.env` 的 `envOrProcess` 规则可保留（单测注入非空值覆盖 setup）。

### 3.2 业务路径

- 六个 log 写入 + 未来 import/export 等：**成功后一律** `scheduleBestEffortNotify` → `notify_*`。  
- Handler **不再**读 body suppress；未知键规则中删除该字段。  
- 是否发出去：**仅**由 `SUPPRESS_BOT_NOTIFICATION`（+ 渠道是否配置）决定。

### 3.3 环境矩阵（含 deploy + probe）

| 环境 | `SUPPRESS_BOT_NOTIFICATION` | 业务自动 notify | Probe |
|------|------------------------------|-----------------|-------|
| `.env.test` / 本地 vitest / Go TestMain / `test:integration` | `=1`（文件或 setup 设；本地可手写） | **不**实发 | 不受约束；测试里若真调 probe 会实发（§4） |
| **`deploy -- test`** → FC/SCF | 脚本**强制注入 `=1`**（用户透明；覆盖漏写） | 云上业务路径 **不** notify | **仍可**验渠道（真发） |
| **`deploy -- prod`** → `.env.prod` / collect / Vercel / FC / SCF | 脚本**强制注入 `=0`**（不问用户；覆盖误带的 `1`） | 正常发 | 正常 |
| 开发者本机临时想业务真发 | 去掉该键或改非 `'1'`（如 `'0'`） | 真发（自担风险） | 同左 |

**云上以 deploy 注入为准**（见 §2.5）：test=`1`、prod=`0`；本地 `.env.test` 仍可写 `=1`，但不替代云上强制值。**probe 仍可验渠道**。

---

## 4. Probe 例外（写死）

**例外是架构路径，不是第二个 env。**

### 4.1 压制范围

- `SUPPRESS_BOT_NOTIFICATION=1` 压制的是：**业务成功路径**上 schedule 出去的自动 bot notify（录入 / transition 等 → `notify_user` / `NotifyUser`）。
- **`POST /api/telegram/probe`、`POST /api/qqbot/probe` 不受该开关约束**：仍直调渠道 `sendTelegramMessage` / `SendMessage`（QQ 同理），**仍走真实渠道发送**。

### 4.2 对照表

| | 业务自动 notify | Probe |
|--|-----------------|-------|
| 入口 | `notify_user` / `NotifyUser` | 各渠道 `send*` / `SendMessage` |
| 是否读 `SUPPRESS_BOT_NOTIFICATION` | **是**（门闸） | **否** |
| `deploy -- test`（脚本注入 SUPPRESS=`1`） | 业务路径**不**实发 | **仍可真发**（验渠道） |
| 体量 | 集成测会大量打写路径 → **必须**压制 | 测试 / 冒烟里偶发调用，**次数少、可控**，**可接受**（不会像业务集成测那样爆炸） |
| 单测 | mock `notify` 或 mock fetch；setup 默认 SUPPRESS=1 | 已有 mock fetch；与 SUPPRESS 无关 |

### 4.3 测试里执行 probe

测试代码（或对已部署 test 函数做冒烟）若调用 probe，会**正常真发** bot。这是刻意保留的验渠道能力；不要给 probe 再套一层 suppress。

> 现状（2026-08-04）：仓库 probe 单测（`tests/api/probe.test.ts`）全部 mock fetch、**零真发**，且畸形 JSON 断言 bot API 零调用；真发仅发生在对已部署 test 函数做冒烟时（次数少、可控）。

禁止为 probe 增加 `NOTIFY_ALLOW_*` /「probe 绕过 SUPPRESS」之类对称开关——probe **根本不进入** suppress 函数。

### 4.4 对外一句（用户可见英文，实现时写 README）

> Deploy injects `SUPPRESS_BOT_NOTIFICATION` automatically (`test` → `1`, `prod` → `0`). With `=1`, insert/transition auto notify stays silent; `POST /api/telegram/probe` and `POST /api/qqbot/probe` still send because they call channel send APIs directly. Occasional probe sends in tests are expected and low-volume.

---

## 5. 测试与单测替代方案

### 5.1 默认静默（集成 / setup）

- `.env.test` / `.env.test.example`：**显式** `SUPPRESS_BOT_NOTIFICATION=1`（本地配置真源；见 §2.5）。  
- `tests/setup.ts` / Go TestMain / `test-integration`：设同一键为 `1`（双保险，防 dotenv 未加载）。  
- **不要**再隐式设 `DIGITAL_TWIN_TEST`；实现时从 setup / TestMain / test-integration **整删**该键，**不**写入 `.env.test`。  
- 集成测可继续「清空渠道 Getenv」作第二道保险。

### 5.2 单测要覆盖「真发路径逻辑」

**不要**再引入 `NOTIFY_ALLOW_IN_TEST` 或任何 `*_ALLOW_IN_TEST`。

推荐（按优先级）：

1. **测 schedule / handler**：mock `notify_user` / `NotifyUser`（spy 调用次数与文案）；不依赖 env。  
2. **测 `notify_user` 扇出**：用例内注入 `env: { SUPPRESS_BOT_NOTIFICATION: '' }` **不够**（空会回退 `process.env`）；应注入**非空且非 `'1'`** 的哨兵（例如 `'0'`）覆盖 setup，或对该用例 `delete process.env.SUPPRESS_BOT_NOTIFICATION`，再配 **mock fetch**。  
3. **测门闸本身**：表格驱动——未设 / `''` / `'0'` / `'1'` / `' 1 '` → 期望 skip 或否。

### 5.3 曾用 ALLOW 放行的用例迁移

| 旧 | 新 |
|----|----|
| setup：`DIGITAL_TWIN_TEST=1` + 用例 `NOTIFY_ALLOW_IN_TEST=1` + mock fetch | setup：`SUPPRESS_BOT_NOTIFICATION=1`；用例注入 `SUPPRESS_BOT_NOTIFICATION: '0'`（或 unset）+ mock fetch |
| 断言 `shouldSkipNotifyInTest({ DIGITAL_TWIN_TEST: '1' }) === true` | `shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: '1' }) === true` |
| 断言 ALLOW 覆盖 | 删除；改为「非 `'1'` 不 skip」 |

---

## 6. 迁移对照表（旧 → 新）

| 旧 | 新 |
|----|----|
| 请求体 `suppress_notification`（按请求关通知） | **删除**；一律 schedule；改用进程级 `SUPPRESS_BOT_NOTIFICATION` |
| `DIGITAL_TWIN_TEST=1` 跳过 notify | `SUPPRESS_BOT_NOTIFICATION=1` 跳过**业务** `notify_user`（probe 仍真发） |
| `NOTIFY_ALLOW_IN_TEST=1` 放行 | **删除**；单测用 unset / 注入非 `'1'` + mock |
| `TELEGRAM_ALLOW_IN_TEST`（已废弃残留） | 确保 setup/文档无残留 |
| `shouldSkipNotifyInTest` / `ShouldSkipNotifyInTest` | `shouldSuppressBotNotification` / `ShouldSuppressBotNotification`（建议） |
| `.env.test` 不写 suppress、靠进程设 DIGITAL_TWIN_TEST | `.env.test` **写入** `SUPPRESS_BOT_NOTIFICATION=1` |
| test FC/SCF 白名单无跳过键（现状会实发） | 白名单**一律放行**该键；`deploy -- test` 强制 `=1`（见 §2.5）；业务静音、probe 仍可验渠道 |
| prod collect / `.env.prod` / Vercel / FC / SCF | 白名单**同样放行**该键；`deploy -- prod` 强制注入 `=0`（不问用户） |

---

## 7. 实现时待办（本篇不落地）

1. OpenAPI + fixtures：删字段；`npm run openapi:lint` / `test:openapi`。  
2. 双端 drafts / handlers / suppress helper：删；成功一律 schedule。  
3. `notify` 门闸换键 + 改名；删 ALLOW 分支。  
4. setup / TestMain / test-integration / `.env.test.example`（本地可写 `=1`；云上仍以 deploy 为准）。  
5. FC/SCF（及 Vercel upsert）白名单**一律放行** `SUPPRESS_BOT_NOTIFICATION`（常驻含键）；`deploy -- test` 强制写 `1`，`deploy -- prod` / collect 生成 `.env.prod` 时**不问**、自动追加 `=0`（覆盖误带的 `1`）。**分环境的只是值，不是「白名单加不加」。**  
6. 更新 layering §7、todo 规格中 suppress 表述、`faas/README.md`、`openapi/README.md`（**实现时同步**；本篇为决策真源）。  
7. 双端单测 / 契约测 / 集成测全绿。

---

## 8. 待实现时同步的现有文档（pointer）

> **阶段 4 已完成**：下表冲突句已改为与终态一致，并以本篇为决策真源。

| 文档 | 冲突点（已对齐） |
|------|--------|
| `docs/20260801-api-layering.md` §7 | 一律 schedule；无 body suppress；`SUPPRESS_BOT_NOTIFICATION` + probe 例外 |
| `docs/20260802-todo-feature.md` | 创建 / transition 无 body suppress；notify 静音见 env |
| `docs/20260803-records-import-export.md` | 一律 Notify + 指向本 env 门闸 |
| `faas/README.md` / `openapi/README.md` | deploy 注入 test=`1` / prod=`0`；probe 不受 SUPPRESS 约束 |
| `.env.test.example` | 显式 `SUPPRESS_BOT_NOTIFICATION=1` + 注释 |
| 发展日志 | 历史叙述保留；加 pointer 指向本篇 |

---

## 9. 实现时确认项（已全部落地，保留决策记录）

| # | 项 | 建议默认（已按此落地） | 状态 |
|---|-----|----------|------|
| 1 | 云注入实现细节（写 OPTIONAL / VERCEL_KEYS / `.env.prod` 的先后顺序） | **白名单一律放行该键** + deploy 按环境强制设值（test=`1` / prod=`0`）；与现 FC/SCF 白名单模式一致 | 已落地（阶段 2） |
| 2 | 函数改名是否与行为同一 PR | 同一 PR，避免旧名误导 | 已落地（阶段 1） |
| 3 | `telegram` TestMain 设测试 flag | 删除（SendMessage 不读 suppress） | 已落地（阶段 1） |
| 4 | 本地 `next dev` 是否默认加载 `.env.test` 从而带上 SUPPRESS=1 | 现状本就用 `.env.test`；开发者若要本地真发需临时去掉该键或改非 `'1'`——可接受 | 已接受 |

无产品语义未决：请求体 suppress、**`DIGITAL_TWIN_TEST` 无其它功能可整删（无拆分旁路）**、ALLOW、严格仅 `'1'` 才跳过、**白名单一律放行 + deploy 注入（test=`1` / prod=`0`，用户透明）**、本地 `.env.test` 显式写 SUPPRESS=`1`、进程级 vs 按请求对比、probe 例外（含测试偶发真发可接受）均已锁定并落地。

---

## 10. 实现阶段

> 本节把 §7 拆成可独立 merge / 验收的阶段。**不写**逐文件实现细节；执行时另开会话按阶段落地。  
> **顺序理由：** 先换进程门闸（本地/CI 静音不断档）→ 再修云上 deploy 注入缺口 → 最后一次性删请求体 `suppress_notification`（避免 OpenAPI 与双端长期半删半留）→ 文档收尾。阶段 2 与 3 在阶段 1 合并后可并行开发。

### 过渡窗口（仅阶段 1→3）

| 窗口 | 行为 | 说明 |
|------|------|------|
| 阶段 1 已合、阶段 3 未合 | 业务仍可被 body `suppress_notification` 跳过 schedule；**同时** `notify_user` 只认 `SUPPRESS_BOT_NOTIFICATION` | 双门闸并存；测试静音靠新 env，不靠 body。**勿**长期停留：客户端仍能按请求关通知 |
| 阶段 3 合并后 | 仅 env 门闸；body 字段从契约消失 | 过渡结束 |

禁止「只删一端 body / 只改 OpenAPI 不改代码」的中间态对外可见超过一个 PR。

---

### 阶段 1：门闸换键并删除模糊 env

**状态：已完成**

**目标：** 业务 `notify_user` / `NotifyUser` 唯一认 `SUPPRESS_BOT_NOTIFICATION`（严格 `'1'` 才跳过）；整删 `DIGITAL_TWIN_TEST` / `NOTIFY_ALLOW_IN_TEST`。

**范围：**
- Next / Go：`notify` 门闸函数（建议改名 `shouldSuppressBotNotification` / `ShouldSuppressBotNotification`）及对应单测
- `tests/setup.ts`、Go 相关 TestMain、`scripts/test-integration.ts`
- `.env.test.example` 显式写入 `SUPPRESS_BOT_NOTIFICATION=1`（本地 `.env.test` 由维护者自行对齐；**本阶段脚本/实现勿动密钥文件内容以外的秘密**）
- 注释中 DIGITAL_TWIN_TEST / ALLOW 表述（notify / integration 相关）

**不做什么：**
- 不删请求体 `suppress_notification`、不改 OpenAPI / drafts / handlers 的 schedule 条件
- 不改 FC/SCF/Vercel deploy 白名单或 collect
- 不改 probe 路径；不改 DB 安全门闸
- 不改 layering / todo / faas README 等大段规格文（留给阶段 4；本阶段仅代码旁注释可顺手）

**验收标准：**
- [x] `shouldSuppressBotNotification` / `ShouldSuppressBotNotification`：未设 / `''` / `'0'` / `'1'` / 其它值 行为符合 §3.1
- [x] 仓库内代码与测试**无** `DIGITAL_TWIN_TEST` / `NOTIFY_ALLOW_IN_TEST` 读写（文档旧叙述可暂留至阶段 4）
- [x] setup / TestMain / test-integration 默认 `SUPPRESS_BOT_NOTIFICATION=1`；扇出单测用注入非 `'1'` + mock fetch（无 ALLOW）
- [x] `.env.test.example` 含显式 `SUPPRESS_BOT_NOTIFICATION=1`
- [x] `npm test`（notify 相关）与 `cd faas && go test`（notify / httpx TestMain 相关）绿
- [x] probe 单测仍不依赖 SUPPRESS（行为不变）

**依赖 / 可并行：** 无前置。阶段 2、3 依赖本阶段合并后才有完整「云静音 + 删 body」语义；本阶段可单独 merge。

---

### 阶段 2：deploy 强制注入 `SUPPRESS_BOT_NOTIFICATION`

**状态：已完成**

**目标：** 白名单常驻该键；`deploy -- test` 强制 `=1`，`deploy -- prod`（Vercel / FC / SCF）强制 `=0`；collect / 问答不问用户。

**范围：**
- FC / SCF `deploy.ts` 白名单（REQUIRED/OPTIONAL 或等价常驻列表）
- `collect-prod-env` / `.env.prod` 生成逻辑：自动追加 `SUPPRESS_BOT_NOTIFICATION=0`（覆盖误带的 `1`）
- Vercel prod upsert 键列表（`VERCEL_KEYS` 或等价）
- 根 `deploy` 编排（若需在 test/prod 分支强制写值）
- 针对注入逻辑的脚本单测或可跑的断言（若仓库已有 deploy 脚本测）

**不做什么：**
- 不改 `notify` 运行时语义（假定阶段 1 已合）
- 不删 body suppress；不改 OpenAPI
- 不向用户增加交互问题；不把真实 Accelerate URL / 密钥写入 git
- 不要求本阶段实际对线上执行 `deploy`（可用脚本单测 / dry-run / 生成物检查验收）

**验收标准：**
- [x] FC/SCF/Vercel 白名单**一律包含** `SUPPRESS_BOT_NOTIFICATION`（test/prod 都含键，不分环境加减键）
- [x] test 路径生成的环境（`s.yaml` / `.scf-build/.env` 等）中该键为 `1`
- [x] prod 路径（collect → `.env.prod` / upsert）中该键为 `0`，且即使用户源文件带 `1` 也被覆盖
- [x] collect / deploy 问答流**不出现**对该键的提示
- [x] 相关脚本测试绿（若有）；否则提供可重复的手工检查步骤并勾选

**依赖 / 可并行：** **依赖阶段 1**（否则云上注入的键无运行时读者，test 云仍可能实发）。与**阶段 3 可并行**开发/开 PR（文件面基本不重叠）；建议阶段 1 合入后再合本阶段。

---

### 阶段 3：删除请求体 `suppress_notification`（OpenAPI + 双端）

**状态：已完成**

**目标：** 契约与实现同步去掉按请求关通知；成功写路径**一律** schedule → `notify_*`（真发与否仅看阶段 1 的 env）。

**范围：**
- `openapi/paths/`、`openapi/components/schemas.yaml`、相关 fixtures
- Next：`suppress-notification` helper、各 draft 允许键、六个（及已有）写路径 handler
- Go：`notify.ReadSuppressNotification` / `suppress.go`、drafts、`httpx` handlers
- 依赖该字段的 route / contract / httpx / integration 断言

**不做什么：**
- 不改 SUPPRESS 门闸语义或 deploy 注入
- 不给 probe 加 suppress；不把 channel `configError` 并入门闸
- 不借机大改 import/export 等未就绪写路径（若尚未 schedule，仅保证与「一律 Notify」规格不冲突；已有路径必须一律 schedule）

**验收标准：**
- [x] OpenAPI / fixtures **无** `suppress_notification`；`npm run openapi:lint`、`npm run test:openapi` 绿
- [x] Next + Go 无 ReadSuppress / 按 body 跳过 schedule；未知键规则不再允许该字段
- [x] `cd faas && go test ./internal/contract/` 及双端相关单测 / 契约测绿
- [x] 有 DB 的集成测：在 `SUPPRESS_BOT_NOTIFICATION=1` 下写路径成功且不实发 bot（或 mock 断言 schedule 仍发生）
- [x] **无**「OpenAPI 已删、一端仍接受该字段」的可合并中间提交对外长期存在（同一 PR 或紧耦合连续 PR 同日合入）

**依赖 / 可并行：** **依赖阶段 1**（删 body 后测试静音必须靠 SUPPRESS）。与**阶段 2 可并行**。勿与阶段 1 对半合并成「只删 schema」。

---

### 阶段 4：文档与 example 收尾

**状态：已完成**

**目标：** 规格 / README / example 与终态一致；本篇为决策真源，其它文档去掉冲突句并加 pointer。

**范围（§8）：**
- `docs/20260801-api-layering.md` §7
- `docs/20260802-todo-feature.md`
- `docs/20260803-records-import-export.md`（可一句指向本 env）
- `faas/README.md`、`openapi/README.md`（含 §4.4 英文对外句：probe 不受 SUPPRESS 约束；deploy 自动注入）
- `.env.test.example` 注释与阶段 1 对齐复核
- 发展日志：可留历史；新行为以本篇为准（可选一句）

**不做什么：**
- 不改运行时 / OpenAPI / deploy 逻辑（若发现遗漏，回对应阶段修，不在本阶段夹带行为变更）
- 不删本篇；不新增大段重复规格

**验收标准：**
- [x] §8 表内文档无「body 可选 suppress」「DIGITAL_TWIN_TEST / ALLOW 仍为现行机制」等冲突表述
- [x] README 写明：deploy test→`1` / prod→`0`；业务静音 vs probe 仍可真发
- [x] `.env.test.example` 键与注释正确
- [x] 本篇状态改为「已落地」（阶段 1–4 全部完成）

**依赖 / 可并行：** **依赖阶段 1–3 均已合**（文档描述终态）。不可与 1–3 并行作为「唯一真源」合入，以免文档超前/滞后于代码。

---

### 建议落地顺序（总表）

| 顺序 | 阶段 | 可独立验收 | 依赖 | 与其它并行 |
|------|------|------------|------|------------|
| 1 | **阶段 1** 门闸换键 + 删模糊 env | 是（单测 / setup） | — | 先合；解锁 2、3 |
| 2a | **阶段 2** deploy 注入 | 是（脚本生成物 / 测） | 阶段 1 | 与阶段 3 **可并行** |
| 2b | **阶段 3** 删 body suppress（OpenAPI+双端） | 是（openapi + 双端测） | 阶段 1 | 与阶段 2 **可并行** |
| 3 | **阶段 4** 文档 / example 收尾 | 是（文档审阅） | 阶段 1–3 | 不并行（收尾） |

**推荐合入节奏：** `1` →（`2` ∥ `3`）→ `4`。若只能串行：`1` → `2` → `3` → `4`（先修云上实发缺口，再删客户端可关通知的契约）。
