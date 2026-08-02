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

---

## A. `POST /api/db/probe`（专用连接）

### A.1 语义

每次开短命连接，两次 `SELECT 1`，`to_regclass('public.records')`。成功字段：`ok`、`databaseReachable`、`recordsTableExists`、`connectMs`、`select1FirstMs`、`select1SecondMs`。契约见 OpenAPI `DbProbeSuccess`、`faas/internal/dbprobe`、`src/lib/dbprobe.ts`。

```http
POST /api/db/probe
Authorization: Bearer <ApiToken>
```

### A.2 结果摘要（本轮，2026-08-02 晚）

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

本轮两侧 `connectMs` 均值接近；**墙钟仍差约 7×**，说明 probe 体感主要由链路 / 调度 / 冷启动外围主导，而非库内三次查询之和。

> 更早一轮（同日、未记逐次 wall）：服务端 connect 均值约 Aliyun ~738 / Tencent ~410；墙钟约略 Tencent ~0.6–1.0 s、Aliyun ~5.8–11.3 s。趋势一致，以本表逐次 **wallMs** 为准。

---

## B. `GET /api/query/transaction/summary`（连接池复用）

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

### B.2 结果摘要

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

Tencent 池路径相对 probe 明显更快（均值 ~850 → ~226 ms）；Aliyun 仍卡在约 5.3 s 量级，改善有限（probe ~5866 → summary ~5279）。

---

## C. 对比解读

| 维度 | 观察 |
|------|------|
| **专用连接 vs 池复用** | SCF 上池路径墙钟约为 probe 的 **1/4**（省掉反复建连）。FC 上两者都在 **~5–6 s**，池复用几乎吃不掉外围开销。 |
| **Aliyun vs Tencent** | 同日、同库：SCF test 墙钟全面更短（probe ~7×，summary ~23×）。 |
| **库内 vs 墙钟** | probe 的 `connectMs`+两次 `SELECT 1` 远小于 FC 墙钟；FC 瓶颈更像 **客户端→函数** 路径，而非 Neon 查询本身。 |
| **选型** | 业务读路径（summary 等）更贴近真实 API；若只看当日 test 延迟，SCF 更优。生产仍要看地域、配额、出网与成本（见多云文档）。 |

---

## D. 如何复现（本地）

1. 确认 FC test / SCF test 已部署且含 `DATABASE_URL` + Tokens；summary 路由已随二进制上线。
2. 从本地 env / `faas/providers/aliyun-fc/scripts/info.sh test` / 已知 SCF Web URL 取 Base URL（**勿提交**）。
3. **Probe**：循环 `POST /api/db/probe`，记录 JSON 三个 ms + 客户端 **wallMs**。
4. **Summary**：循环 `GET /api/query/transaction/summary?from=…&to=…`（窄窗口即可），记录 HTTP 状态、`success` / counts / `net`（勿贴大 payload）+ **wallMs**。
5. 只提交聚合数字与表格；禁止 URL / Token / 连接串进 git。
