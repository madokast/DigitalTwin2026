# DigitalTwin2026：双云 `POST /api/db/probe` 多轮对比（FC vs SCF）

> 日期：2026-08-02（UTC+8）  
> 性质：实测记录（reference）  
> 相关：[`docs/20260802-faas-multi-cloud.md`](20260802-faas-multi-cloud.md)、[`docs/20260801-api-layering.md`](20260801-api-layering.md)（`dbprobe`）、OpenAPI `POST /api/db/probe`  
> 相关提交：`a07c1f2`（db probe）、`2305872`（集成测不再 DROP schema）

## 1. 测了什么

在 **Aliyun FC test** 与 **Tencent SCF test** 双端部署就绪后，对两侧分别连续调用 5 次：

```http
POST /api/db/probe
Authorization: Bearer <ApiToken>
```

- Base URL：本地环境中的 **Aliyun FC test Base URL** / **Tencent SCF test Base URL**（**不进 git**；SCF 侧为 `tencentscf.com` Web 函数形态，本文不硬编码真实 URL）。
- 鉴权：ApiToken（AI token 即可；**勿**把真实 Token、`DATABASE_URL` 或函数 URL 写入仓库）。
- 两端指向同一套测试库（标准 PostgreSQL / Neon 语义）。

## 2. 探测语义（提醒）

`dbprobe` 每次开**短命**连接，跑两次 `SELECT 1`，并用 `to_regclass('public.records')` 看表是否存在。成功响应字段：

| 字段 | 含义 |
|------|------|
| `ok` | `databaseReachable` 且 `public.records` 存在 |
| `databaseReachable` | HTTP 200 时恒为 true（连不上 → 503） |
| `recordsTableExists` | `public.records` 是否存在 |
| `connectMs` | 打开专用连接耗时（ms） |
| `select1FirstMs` / `select1SecondMs` | 同连接上第一次 / 第二次 `SELECT 1`（ms） |

**不**查询 `__drizzle_migrations`。契约与实现见 OpenAPI `DbProbeSuccess`、`faas/internal/dbprobe`、`src/lib/dbprobe.ts`。

## 3. 结果摘要

两侧各 5 次全部：

- HTTP **200**
- `ok=true`
- `recordsTableExists=true`

## 4. 服务端计时（ms）

服务端回报的 `connectMs` / `select1FirstMs` / `select1SecondMs`：

| # | Aliyun FC（connect / first / second） | Tencent SCF（connect / first / second） |
|---|---------------------------------------|-----------------------------------------|
| 1 | 1609.6 / 72.9 / 72.4 | 676.0 / 52.1 / 52.0 |
| 2 | 457.5 / 75.8 / 75.7 | 415.3 / 50.0 / 50.2 |
| 3 | 794.1 / 69.6 / 69.5 | 342.4 / 54.5 / 54.9 |
| 4 | 413.5 / 68.5 / 68.9 | 314.5 / 51.1 / 50.8 |
| 5 | 415.3 / 67.1 / 66.6 | 301.8 / 48.8 / 48.9 |

**connect 均值（约）**：Aliyun **~738 ms**；Tencent **~410 ms**。

## 5. 客户端墙钟

客户端观测到的整次请求墙钟（含 TLS、调度、链路）：

| 侧 | 约略范围 |
|----|----------|
| Tencent SCF | ~0.6–1.0 s |
| Aliyun FC | ~5.8–11.3 s |

墙钟差距远大于 DB 内部 `connectMs` / `SELECT 1`，说明 **链路 / 调度 / 冷启动外围** 往往比库内查询更主导体感延迟。

## 6. 解读

- **首连偏高**：第 1 轮（尤其 Aliyun `connectMs` 1609）符合冷连接 / 冷实例；后续轮次回落。
- **Tencent 连接更稳更快**：connect 均值更低（~410 vs ~738），且波动更小（Aliyun 仍有 794 等尖峰）。
- **`SELECT 1`**：Tencent 约 **~50 ms**，Aliyun 约 **~70 ms**；同连接上 first / second 几乎持平，说明单次查询开销稳定。
- **选型含义**：双云均可达库且表在；若只看 probe 与墙钟，当日 SCF test 路径更短。生产选型仍要结合地域、配额、出网（Telegram 等）与成本，见多云文档。

## 7. 如何复现（本地）

1. 部署 / 确认 FC test 与 SCF test 已带 `DATABASE_URL` + Tokens。
2. 从本地 env 取 Base URL（勿提交）。
3. 对每侧循环 `curl`（或等价）`POST /api/db/probe`，记录 JSON 中的三个 ms 字段与客户端墙钟。
4. 对比时只提交**聚合数字**；禁止提交 URL / Token / 连接串。
