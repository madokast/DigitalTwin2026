# DigitalTwin2026：双云 API 延迟对比（FC vs SCF）

> 日期：2026-08-02（UTC+8）  
> 性质：实测记录（reference）  
> 相关：[`docs/20260802-faas-multi-cloud.md`](20260802-faas-multi-cloud.md)、[`docs/20260801-api-layering.md`](20260801-api-layering.md)（`dbprobe` / `query`）、OpenAPI `POST /api/db/probe`、`GET /api/query/transaction/summary`  
> 相关提交：`a07c1f2`（db probe）、`2305872`（集成测不再 DROP schema）

本文对比两条路径：

| 段 | 端点 | DB 连接语义 |
|----|------|-------------|
| **A** | `POST /api/db/probe` | 每次**短命专用连接**，测完关闭 |
| **B** | `GET /api/query/transaction/summary` | 进程级 **`pgxpool` / 共享 client 复用** |

Base URL：本地 **Aliyun FC test** / **Tencent SCF test**（**不进 git**）。鉴权：ApiToken（`DIGITAL_TWIN_TOKEN` 即可）。两端同一测试库。墙钟为客户端 `curl %{time_total}`（ms）。

**重要：** 客户端墙钟极易被本机 **VPN / HTTP(S)_PROXY** 扭曲。以 **§E（清代理 + `curl --noproxy '*'`）** 为可信结论；§A/§B 保留为「未强制绕过代理」对照。

---

## A. `POST /api/db/probe`（专用连接）— 未强制绕过代理

### A.1 语义

每次开短命连接，两次 `SELECT 1`，`to_regclass('public.records')`。成功字段：`ok`、`database_reachable`、`records_table_exists`、`connect_ms`、`select1_first_ms`、`select1_second_ms`。契约见 OpenAPI `DbProbeSuccess`、`faas/internal/dbprobe`、`src/lib/dbprobe.ts`。

```http
POST /api/db/probe
Authorization: Bearer <ApiToken>
```

### A.2 结果摘要（同日晚，未 `--noproxy`）

两侧各 5 次全部 HTTP **200**，`ok=true`，`recordsTableExists=true`。

### A.3 服务端计时 + 客户端墙钟（ms）

| # | Aliyun FC（connect / first / second / **wallMs**） | Tencent SCF（connect / first / second / **wallMs**） |
|---|-----------------------------------------------------|--------------------------------------------------------|
| 1 | 588.3 / 80.5 / 80.2 / **6076.1** | 548.0 / 52.2 / 52.5 / **943.7** |
| 2 | 430.6 / 67.7 / 67.9 / **5845.0** | 447.2 / 52.9 / 52.6 / **780.8** |
| 3 | 456.0 / 68.4 / 68.8 / **5858.5** | 325.8 / 52.4 / 52.4 / **693.8** |
| 4 | 400.5 / 65.6 / 65.2 / **5766.5** | 371.9 / 50.6 / 50.6 / **866.2** |
| 5 | 424.8 / 64.3 / 64.7 / **5782.4** | 642.1 / 51.4 / 51.1 / **963.7** |

| 侧 | connect 均值（约） | wallMs 范围 / 均值 |
|----|--------------------|--------------------|
| Aliyun FC | ~460 ms | **~5.77–6.08 s** / **~5866 ms** |
| Tencent SCF | ~467 ms | **~0.69–0.96 s** / **~850 ms** |

> 事后证明：当时 FC 墙钟被本机出口路径放大；**勿据此认定 Neon 或 FC 函数本身慢一个数量级**。见 §E。

---

## B. `GET /api/query/transaction/summary`（连接池复用）— 未强制绕过代理

### B.1 端点与语义

```http
GET /api/query/transaction/summary?from=<ISO+tz>&to=<ISO+tz>
Authorization: Bearer <ApiToken>
```

- **必填 query**：`from`、`to`（半开 `[from, to)`；`from >= to` → 400）。
- **鉴权**：ApiToken。
- **聚合**：区间内带 `transaction_entry:income|expense` 且合法 `{category}:{subcategory}` 的行；金额为两位小数串；脏行跳过。
- **池复用**：Go `FetchTransactionSummary(ctx, s.Pool, …)`（进程 `pgxpool`）；Next 走共享 `src/db` drizzle/postgres client。与 probe **不同**：不按请求开/关专用连接。
- OpenAPI：`TransactionSummarySuccess`；实现：`faas/internal/query`、`src/lib/query.ts`、路由 Next `src/app/api/query/transaction/summary`、Go `httpx.handleTransactionSummary`。

本轮查询窗口刻意收窄（空结果，偏延迟）：

`from=2026-01-01T00:00:00Z` & `to=2026-01-02T00:00:00Z`

### B.2 结果摘要（同日晚，未 `--noproxy`）

两侧各 5 次全部 HTTP **200**，`success=true`，`income.count=0`，`expense.count=0`，`net="0.00"`（空区间）。

### B.3 客户端墙钟（ms）

| # | Aliyun FC **wallMs** | Tencent SCF **wallMs** | 响应要点 |
|---|----------------------|------------------------|----------|
| 1 | **5356.7** | **269.2** | 200；空汇总 |
| 2 | **5266.8** | **213.5** | 同上 |
| 3 | **5233.9** | **204.9** | 同上 |
| 4 | **5235.0** | **208.7** | 同上 |
| 5 | **5300.6** | **233.1** | 同上 |

| 侧 | wallMs 范围 / 均值 |
|----|--------------------|
| Aliyun FC | **~5.23–5.36 s** / **~5279 ms** |
| Tencent SCF | **~0.20–0.27 s** / **~226 ms** |

---

## C. 对照解读（§A/§B，含代理噪声）

| 维度 | 观察（**可能被 VPN/代理污染**） |
|------|------|
| **专用连接 vs 池复用** | SCF 上池路径墙钟约为 probe 的 **1/4**。FC 上两者都在 **~5–6 s**。 |
| **Aliyun vs Tencent** | 墙钟差约 7×（probe）/ 23×（summary）——**不可信**，见 §E。 |
| **库内 vs 墙钟** | 即便在噪声轮次，probe 的 `connectMs`+两次 `SELECT 1` 已接近两侧同级，说明 **Neon 并非墙钟差距来源**。 |

---

## D. 如何复现（本地）

1. **先清代理**：`unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy`；curl 加 **`--noproxy '*'`**（本机开了 VPN 时尤其重要）。
2. 确认 FC test / SCF test 已部署且含 `DATABASE_URL` + Tokens。
3. 从本地 env / `info.sh` / 已知 Web URL 取 Base URL（**勿提交**）。
4. **Probe**：循环 `POST /api/db/probe`，记录 JSON 三个 ms + **wallMs**。
5. **Summary**：循环 `GET /api/query/transaction/summary?from=…&to=…`（窄窗口），记录状态 + **wallMs**。
6. 只提交聚合数字与表格；禁止 URL / Token / 连接串进 git。

---

## E. 清代理后重测（可信结论，同日晚）

条件：显式清空 `HTTP(S)_PROXY` / `ALL_PROXY` 等，且全部请求使用 `curl --noproxy '*'`。同一 Base URL、同一 Token、同一空 summary 窗口。各云各 5 次，全部 **200** / `ok` 或 `success`。

### E.1 Probe（专用连接）

| # | Aliyun connect / first / second / **wallMs** | Tencent connect / first / second / **wallMs** |
|---|----------------------------------------------|-----------------------------------------------|
| 1 | 452.0 / 73.9 / 73.6 / **2837.9** | 550.4 / 53.0 / 53.4 / **935.4** |
| 2 | 514.2 / 75.2 / 74.6 / **935.5** | 657.7 / 48.1 / 48.3 / **988.9** |
| 3 | 428.5 / 66.7 / 66.3 / **811.7** | 487.3 / 47.6 / 47.4 / **844.4** |
| 4 | 439.6 / 70.1 / 69.9 / **838.1** | 295.8 / 47.4 / 47.6 / **700.0** |
| 5 | 380.0 / 61.1 / 61.1 / **734.4** | 305.2 / 49.7 / 49.4 / **609.4** |

| 侧 | connect 均值（约） | wallMs（含首发）/ 去掉首发均值 |
|----|--------------------|--------------------------------|
| Aliyun FC | ~443 ms | 均值 **~1232**；暖请求 **~830** |
| Tencent SCF | ~459 ms | 均值 **~816**；暖请求 **~786** |

服务端 `connectMs` / `SELECT 1` 两侧同量级；清代理后 **墙钟也同量级**（暖请求约 0.6–1.0 s）。

### E.2 Transaction summary（池复用）

| # | Aliyun **wallMs** | Tencent **wallMs** |
|---|-------------------|--------------------|
| 1 | **325.5** | **543.1** |
| 2 | **205.3** | **153.9** |
| 3 | **202.5** | **160.2** |
| 4 | **161.8** | **176.1** |
| 5 | **178.6** | **174.7** |

| 侧 | wallMs 范围 / 均值 |
|----|--------------------|
| Aliyun FC | **~162–326** / **~215** |
| Tencent SCF | **~154–543** / **~242**（去掉首发约 **~166**） |

### E.3 与 §A/§B 对比 + 结论

| 指标 | 未绕过代理（§A/§B） | 清代理 + `--noproxy '*'`（§E） |
|------|---------------------|--------------------------------|
| FC summary 墙钟均值 | **~5279 ms** | **~215 ms**（约 **25×** 下降） |
| FC probe 墙钟均值 | **~5866 ms** | **~1232 ms**（暖约 **~830**） |
| SCF summary 墙钟均值 | **~226 ms** | **~242 ms**（基本不变） |
| SCF probe 墙钟均值 | **~850 ms** | **~816 ms** |

**结论：**

1. **Neon 不是瓶颈。** 库内 `connectMs` / `SELECT 1` 两侧本来就接近；差距主要在**本机到 FC 的客户端路径**（VPN/代理对 `*.fcapp.run` 不友好，对 SCF 影响小）。
2. **清代理后** FC 与 SCF 的 summary 墙钟都在 **~0.15–0.35 s** 暖请求区间，**没有数量级鸿沟**。
3. Probe（专用连接）暖墙钟仍约 **0.6–1.0 s**，高于 summary 池路径，符合「每次新建连接」预期。
4. 以后双云延迟对比：**必须**记录是否清代理 / 是否 `--noproxy`；否则 FC 墙钟不可比。
