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

## 已对齐约定（摘要）

| 项 | 规则 |
|----|------|
| `happened_at` / query `from`/`to` | 一律要求 ISO 8601 **带时区**（`Z` 或 `±HH:MM` / `±HHMM`）；裸日期或无 offset → 400 |
| `Record.happenedAt` 输出 | UTC `…sssZ`（Go `FormatHappenedAt`；Next `toApiRecord`） |
| `Record.valueNumber` | **仅**十进制字符串 / null（DB `TEXT`）；JSON **number 一律 400**（`value_number must be a decimal string`）；写入保留校验后字面量，不经 Number 往返 |

## Phase 1 已知差异（有意延后）

下列项**已在契约中如实描述**，留给 Phase 2 契约测试再锁死：

| 项 | 现状 | 建议 |
|----|------|------|
| （暂无） | — | — |

其余 8 条路径（log×2、query×3、admin×2、telegram probe）的成功/错误外壳与字段名已对齐；发现新漂移时先改 YAML 再改双端。
