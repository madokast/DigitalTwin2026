# 错误响应结构化（RFC 9457 problem+json）

> 创建日期：2026-08-05
> 性质：契约演进讨论 / 待办文档。错误响应从 `{error: string}` 演进为 RFC 9457 problem+json 结构化格式。
> 触发：Go 代码质量审查（`docs/20260805-go-code-quality.md`）——错误响应是 `map[string]string{"error"}`，非结构化；此系统长期维护，不应因「个人系统」而随意。

## 现状

| 层 | 现状 |
|---|---|
| 契约 | `Error` schema：`{error: string}`（`additionalProperties: false`，`openapi/components/schemas.yaml:1`） |
| Go | `writeError` → `map[string]string{"error": msg}`（`httpx/server.go:200`） |
| Node | 各 route `NextResponse.json({ error: msg }, { status })` |
| OpenAPI | 大量路径 `$ref '#/Error'`（log/query/time/db/qqbot/…） |
| fixtures | `error-*.json`（`error-unauthorized.json` 等 10+ 个） |
| 测试 | contract.test.ts + 双端集成测试断言 `res.error` / `body.error` |

## 目标：RFC 9457 problem+json

标准字段（`type`/`title`/`status`/`detail`/`instance` 均 snake-free 标准键）：

```json
{
  "type": "https://api.example/problems/invalid-parameter",
  "title": "Invalid parameter",
  "status": 400,
  "detail": "Missing required query parameter: from"
}
```

### 字段语义（建议）

| 字段 | 必填 | 语义 |
|---|---|---|
| `type` | 可选 | 问题类型 URI（或 `urn:`）；缺省省略 |
| `title` | 必填 | 人类可读短标题（英文，稳定，供 AI 归类） |
| `status` | 必填 | HTTP 状态码（与响应状态一致） |
| `detail` | 必填 | 具体错误文案（现 `error` 的内容，英文） |
| `instance` | 可选 | 出错资源 URI（本系统可省略） |

- **`title` 是稳定的短标题**（如 `invalid parameter` / `record not found` / `unauthorized` / `payload too large`），AI 可据此分类；`detail` 是可变的细节文案。
- `type` 本系统无外部问题类型注册表，建议省略或用简单 `urn:` 标识。

## 决策点

1. **破坏 vs 兼容**：
   - **A. 彻底 RFC 9457**（删 `error`）：干净，但所有错误消费方（AI 客户端、Node 代码、fixtures、测试）全改——**破坏性契约变更**。
   - **B. 兼容扩展**（保留 `error` 恒等于 `detail` + 增补 `title`/`status`）：旧消费方不坏，新消费方可用结构化——非纯标准，但平滑。
   - 倾向 **A**：系统无历史、未上生产，AI 客户端可更新；「长期维护」优先干净契约。
2. **`type` 是否保留**：倾向**省略**（无注册表，`urn:` 无实际消费方）；如需保留用 `urn:digitaltwin:problems:<slug>`。
3. **title 的取值**：按错误类别枚举（`invalid request` / `unauthorized` / `not found` / `conflict` / `payload too large` / `internal error`），与 HTTP 状态码一一对应。

## 影响面（破坏性，全链路）

- **OpenAPI**：`Error` schema 重写为 problem+json（`required: [title, status, detail]`）；各路径 `$ref '#/Error'` 不变（schema 内部替换）。
- **Go**：`writeError(w, status, msg)` 改为组装 typed struct（`title`/`status`/`detail`）——**同时符合「禁止 map/any jsonify」规范**（`docs/20260805-go-code-quality.md` §2）；`writeInternalError` 同步。
- **Node**：`NextResponse.json({ error })` → 统一 problem 结构；抽公共 helper（如 `lib/httperror.ts`）。
- **fixtures**：`error-*.json` 全部重写。
- **契约测试**：contract.test.ts 的 Error 断言；双端集成测试 `res.error` → `res.detail`。
- **文档**：OpenAPI README、AI 使用文档错误处理节。

## 实施顺序（待决策后）

1. 定案决策点（破坏 A vs 兼容 B；type 取舍；title 枚举）。
2. 双端定义公共错误结构（Go typed struct / Node helper）+ title 映射。
3. OpenAPI `Error` schema 重写 + fixtures 重写。
4. Go / Node 全部错误响应切换（含 401/400/404/409/413/500）。
5. 契约 + 集成测试全量更新；openapi lint。
6. 回归。

## 相关记录

- Go 代码质量规范（错误链 / 禁 map jsonify / slog）：`docs/20260805-go-code-quality.md`。
- 错误契约现状：`openapi/components/schemas.yaml#/Error`。
