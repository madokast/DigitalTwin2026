# 错误响应结构化（RFC 9457 problem+json）

> 创建日期：2026-08-05
> 性质：契约演进**定案**文档。错误响应从 `{error: string}` 演进为 RFC 9457 problem+json 结构化格式。
> 触发：Go 代码质量审查（`docs/20260805-go-code-quality.md`）——错误响应是 `map[string]string{"error"}`，非结构化；此系统长期维护，不应因「个人系统」而随意。

## 现状

| 层 | 现状 |
|---|---|
| 契约 | `Error` schema：`{error: string}`（`additionalProperties: false`，`openapi/components/schemas.yaml:1`） |
| Go | `writeError` → `map[string]string{"error": msg}`（`httpx/server.go`） |
| Node | 各 route `NextResponse.json({ error: msg }, { status })` |
| OpenAPI | 大量路径 `$ref '#/Error'`（log/query/time/db/qqbot/…） |
| fixtures | `error-*.json`（`error-unauthorized.json` 等 10+ 个） |
| 测试 | contract.test.ts + 双端集成测试断言 `res.error` / `body.error` |

## 定案：RFC 9457 problem+json（扩展 success）

**形状**（双端逐字一致）：

```json
{"success":false,"title":"Bad Request","status":400,"detail":"missing required query parameter: from"}
```

- **Content-Type**：`application/problem+json`
- **key 顺序**：`success` → `title` → `status` → `detail`（`success` 恒第一，符合 go-code-quality 模板）

### 字段语义（定案）

| 字段 | 必填 | 语义 |
|---|---|---|
| `success` | 必填（恒 `false`） | 与成功响应 `{success: true}` 包络统一；AI 判断成败只看此布尔 |
| `title` | 必填 | 人类可读短标题——**标准 HTTP reason phrase**（见「title 来源」） |
| `status` | 必填 | HTTP 状态码（与响应状态一致） |
| `detail` | 必填 | 具体错误文案（现 `error` 的内容，英文，已小写化——见 `go-code-quality.md` §1） |
| `type` | **省略** | 无问题类型注册表消费方；RFC 9457 允许省略（客户端假设 `about:blank`） |
| `instance` | 省略 | 本系统不需要 |

### title 来源（标准库，零自维护 + 413 特例）

**title 直接取 HTTP 标准 reason phrase，不维护自定义映射表**：

| 侧 | 来源 |
|---|---|
| Go | `http.StatusText(status)`（`net/http`） |
| Node | `http.STATUS_CODES[status]`（`node:http`） |

**413 特例**：双端标准库对 413 的 reason phrase **不一致**——Go 返回 RFC 7231 旧名 `Request Entity Too Large`，Node 返回 RFC 9110 新名 `Payload Too Large`。**统一为 RFC 9110 新名 `Payload Too Large`**：Go 端 `statusTitle()` 对 413 覆盖（其余 `http.StatusText`）；Node 端标准库已含新名，无需处理。

**title 映射（实测验证）**：

| status | title（双端一致） |
|---|---|
| 400 | Bad Request |
| 401 | Unauthorized |
| 404 | Not Found |
| 409 | Conflict |
| 413 | Payload Too Large（**Go 特例覆盖**） |
| 500 | Internal Server Error |

## 决策记录（已定案）

1. **破坏 vs 兼容**：**A. 彻底**（删 `error`）——系统无历史、未上生产，AI 客户端可更新；「长期维护」优先干净契约。
2. **`type` 省略**：无注册表消费方；detail + status 已够 AI 分类。
3. **`title` 用标准库 reason phrase**（不细分、不自维护）：双端各读标准库天然一致；`detail` 已承载每条错误的具体信息；细分需双端各维护映射表，易漂移。
4. **加 `success: false`**：与既有 `{success: true}` 包络统一，AI 判断成败只读一个布尔。

## 影响面（破坏性，全链路）

- **OpenAPI**：`Error` schema 重写为 problem+json（`required: [success, title, status, detail]`）；各路径 `$ref '#/Error'` 不变（schema 内部替换）。
- **Go**：`writeError(w, status, detail)` 组装 typed struct（`success`/`title`/`status`/`detail`）——**同时符合「禁止 map/any jsonify」规范**；`writeInternalError` 同步；`statusTitle()` 处理 413 特例。
- **Node**：`NextResponse.json({ error })` → 统一 problem 结构；抽公共 helper（如 `lib/httperror.ts`，`success:false` + `STATUS_CODES`）。
- **fixtures**：`error-*.json` 全部重写。
- **契约测试**：contract.test.ts 的 Error 断言；双端集成测试 `res.error` → `res.detail`。
- **文档**：OpenAPI README、AI 使用文档错误处理节。

## 实施顺序（待开工）

1. 双端定义公共错误结构（Go `ErrorResponse` struct / Node helper）+ `statusTitle`（413 特例）。
2. OpenAPI `Error` schema 重写 + fixtures 重写。
3. Go / Node 全部错误响应切换（含 401/400/404/409/413/500）。
4. 契约 + 集成测试全量更新；openapi lint。
5. 回归。

## 相关记录

- Go 代码质量规范（错误链 / 禁 map jsonify / slog / 契约文案小写化）：`docs/20260805-go-code-quality.md`。
- 错误契约现状：`openapi/components/schemas.yaml#/Error`。
