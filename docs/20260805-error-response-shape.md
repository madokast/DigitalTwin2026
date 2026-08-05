# 错误响应结构化（RFC 9457 problem+json）

> 创建日期：2026-08-05
> 性质：契约演进**定案**文档。错误响应从 `{error: string}` 演进为 RFC 9457 problem+json 结构化格式。
> 触发：Go 代码质量审查（`docs/20260805-go-code-quality.md`）——错误响应是 `map[string]string{"error"}`，非结构化；此系统长期维护，不应因「个人系统」而随意。

## 现状（已实现，S1-S4）

| 层 | 现状 |
|---|---|
| 契约 | `Error` schema：problem+json（`required: [success, title, status, detail]`，`success.const: false`） |
| Go | `writeError` → `ProblemResponse` struct + `statusTitle`（`httpx/httperror.go`）；Content-Type `application/problem+json` |
| Node | 各 route → `errorResponse()` helper（`src/lib/httperror.ts`） |
| OpenAPI | 所有 `$ref '#/Error'` 指向 problem+json schema；response media type `application/problem+json` |
| fixtures | `error-*.json`（11 个）全部 problem+json 形状 |
| 测试 | contract.test.ts 锁形状 / key 顺序；双端集成测试断言 `res.detail` / `body.detail` |

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

### title 来源（薄包装 `statusTitle`，双端同名）

**title 取 HTTP 标准 reason phrase，经一层薄包装函数（双端 stem 对齐）**，不维护自定义映射表：

```go
// Go（faas/internal/httpx/httperror.go）
// 413 特例：Go 标准库返回 RFC 7231 旧名 "Request Entity Too Large"，
// Node 标准库返回 RFC 9110 新名 "Payload Too Large"——双端统一新名。
func statusTitle(status int) string {
	if status == http.StatusRequestEntityTooLarge {
		return "Payload Too Large"
	}
	return http.StatusText(status)
}
```

```ts
// Node（src/lib/httperror.ts）——已含 RFC 9110 新名，413 无需特例
export function statusTitle(status: number): string {
  return http.STATUS_CODES[status] ?? ''
}
```

- **全部错误响应组装走 `statusTitle(status)`**（Go `writeError` / Node 错误 helper）——413 特例**单点**隔离，其余依赖标准库。
- **未知 status**：Go `StatusText` 返回 `""`、Node `STATUS_CODES` 返回 `undefined` → Node fallback `?? ''`，双端一致输出空 title（实际仅用 6 个已知 status）。

**title 映射（实测验证，双端一致）**：

| status | title |
|---|---|
| 400 | Bad Request |
| 401 | Unauthorized |
| 404 | Not Found |
| 409 | Conflict |
| 413 | Payload Too Large（**Go `statusTitle` 特例覆盖**） |
| 500 | Internal Server Error |

## 决策记录（已定案）

1. **破坏 vs 兼容**：**A. 彻底**（删 `error`）——系统无历史、未上生产，AI 客户端可更新；「长期维护」优先干净契约。
2. **`type` 省略**：无注册表消费方；detail + status 已够 AI 分类。
3. **`title` 用标准库 reason phrase**（不细分、不自维护）：双端各读标准库天然一致；`detail` 已承载每条错误的具体信息；细分需双端各维护映射表，易漂移。
4. **加 `success: false`**：与既有 `{success: true}` 包络统一，AI 判断成败只读一个布尔。

## 影响面（破坏性，全链路）

- **OpenAPI**：`Error` schema 重写为 problem+json（`required: [success, title, status, detail]`）；各路径 `$ref '#/Error'` 不变（schema 内部替换）。
- **Go**：`writeError(w, status, detail)` 组装 typed struct（`success`/`title`/`status`/`detail`）——**同时符合「禁止 map/any jsonify」规范**；`writeInternalError` 同步；新增 `httpx/httperror.go` `statusTitle`（413 特例）。
- **Node**：`NextResponse.json({ error })` → 统一 problem 结构；抽公共 helper `src/lib/httperror.ts`（`success:false` + `statusTitle`）。
- **fixtures**：`error-*.json` 全部重写。
- **契约测试**：contract.test.ts 的 Error 断言；双端集成测试 `res.error` → `res.detail`。
- **文档**：OpenAPI README、AI 使用文档错误处理节。

## 实施顺序（定案，分 4 阶段，每阶段独立提交 + 测试绿）

- **S1 双端基建（纯新增，无行为变化）** ✅ `208c5d8`：Go `httpx/httperror.go`（`statusTitle` 含 413 特例 + `ProblemResponse` struct）；Node `src/lib/httperror.ts`（`statusTitle` + `errorResponse` helper）；双端 `statusTitle` 映射单测（含 413 特例）。现有错误响应不变。
- **S2 双端错误响应切换（破坏性主变更）** ✅ `c5521dd`：Go `writeError`/`writeInternalError`/401 → `ProblemResponse` + `statusTitle` + `application/problem+json`；Node 各 route / `unauthorizedResponse` → `errorResponse`；**连带**更新双端集成测试断言（`res.error` → `res.detail`）与 route 单测；`withJSONErrorPages` 404 判断兼容 problem+json；测试断言 `map[string]string` → `map[string]any`（success 为 bool）。
- **S3 OpenAPI + fixtures（契约同步）** ✅ `94cafa9`：`Error` schema 重写（`required: [success, title, status, detail]` + `const: false`）；11 个 `error-*.json` fixtures 重写；`responses.yaml` + 5 个 paths 内联 example 重写（media type `application/problem+json`，3 处旧大写文案顺带小写化）；契约测试增「缺字段 / success:true 拒绝 / key 顺序」断言。
- **S4 收尾回归 + 文档**：本文档标记已实现 + `go-code-quality.md` §8 完成 + `api-layering.md` 同步 + 全量回归。

**分阶段理由**：S1 纯新增零风险；S2 是唯一破坏性步骤（代码切换与测试断言必须同步，否则中间态测试红）；S3 契约与代码切换分离各自可验证；S4 回归收尾。每阶段独立提交、可回滚。

## 相关记录

- Go 代码质量规范（错误链 / 禁 map jsonify / slog / 契约文案小写化）：`docs/20260805-go-code-quality.md`。
- 错误契约现状：`openapi/components/schemas.yaml#/Error`。
