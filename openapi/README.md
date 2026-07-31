# OpenAPI 契约（Phase 1）

本目录是双后端 HTTP API 的**契约源**（Design-first，尚未 codegen）。

| 文件 | 说明 |
|------|------|
| [`openapi.yaml`](./openapi.yaml) | OpenAPI 3.1；路径 / 鉴权 / 请求响应与 Next + Go 实现对齐 |

## 如何编辑

1. 先改 [`openapi.yaml`](./openapi.yaml)（或与实现同步时两边一起改）。
2. 再改 Next（`src/app/api/**`、`src/lib/**`）与 Go（`fc/internal/**`），保持语义一致。
3. 跑现有测试：`npm test` 与 `cd fc && go test ./...`。
4. 用户可见的 `error` / `description` 用英文；本 README 等文档可用中文。

鉴权摘要：`Authorization: Bearer …`；普通路由接受 AI Token 或 Admin Token；`/api/admin/*` 仅 Admin Token。细节以 YAML 中 `securitySchemes` 为准。

## 阶段状态

- **Phase 1（当前）**：契约文档已落地；**无** TypeScript / Go codegen。
- **Phase 2（后续）**：契约测试 / Spectral（或同类）CI，用于约束双端不漂移。
- **可选 codegen**：暂不做；需要时再单独评估。

改 API 时请同时更新本 YAML、两套实现，以及现有双端测试（契约 CI 未就绪前以 Vitest / `go test` 为准）。

## Phase 1 已知差异（有意延后）

下列项**已在契约中如实描述**，暂不强制双端完全同校验；留给 Phase 2 契约测试或产品决策后再收紧：

| 项 | 现状 | 建议 |
|----|------|------|
| Log `happened_at` 输入 | 比 Admin PATCH / query `from`/`to` **更松**：不强制 `(Z\|±HH:MM)` 后缀；Next 用 `new Date`，Go 直接交给 PG `timestamptz` 解析 | 全局收紧需改 AI 录入约定与双端校验，属产品决策；Phase 2 再统一 |
| `Record.happenedAt` 输出 | **已对齐**：两端均为 UTC `…sssZ`（Go `FormatHappenedAt`；Next `toApiRecord`） | Phase 2 契约测试应锁定该格式 |
| `valueNumber` 文本 | 入库路径不同（Next `Number#toString` vs Go `json.Marshal` float）；读出均为 PG numeric 文本 | 一般客户端可忽略；契约测试可对常见样例做快照 |

其余 8 条路径（log×2、query×3、admin×2、telegram probe）的成功/错误外壳与字段名已对齐；发现新漂移时先改 YAML 再改双端。
