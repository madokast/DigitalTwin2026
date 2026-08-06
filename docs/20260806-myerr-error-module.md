# myerr 统一错误模块（决策 D）实施范围与验收

2026-08-06 定稿。替代终稿 §4 的 `StatusError` 草案与现有 `(T, status, error)` 元组：**三层统一错误形态**，handler 400/500 无差别写错误，status 由错误对象自带。

## 1. 目标形态（定稿）

**MyError 只存 `Status` + `Message` 字符串**（不存原始 error、不保链、不引入堆栈）。驱动错误的诊断信息（类型名 + 消息）在构造时烙进 Message。

```go
// faas/internal/myerr/myerr.go
type MyError struct {
	Status  int
	Message string
}
func (e *MyError) Error() string { return e.Message }

func NewNotFound(msg string) *MyError   { return &MyError{Status: 404, Message: msg} }
func NewValidation(msg string) *MyError { return &MyError{Status: 400, Message: msg} }
func NewConflict(msg string) *MyError   { return &MyError{Status: 409, Message: msg} }
func NewInternal(cause error) *MyError  { return &MyError{Status: 500, Message: describe(cause)} }

// describe：驱动错误 → "类型名: 消息"（空消息 → 仅类型名，永不为空）。吸收现有 errorDetail。
func describe(cause error) string {
	if msg := cause.Error(); msg != "" {
		return fmt.Sprintf("%T: %s", cause, msg)
	}
	return fmt.Sprintf("%T", cause)
}
```

```ts
// src/lib/myerr.ts
export class MyError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
const describe = (cause: unknown): string => {
  const name = cause instanceof Error ? cause.constructor.name : typeof cause
  const msg = cause instanceof Error ? cause.message : String(cause)
  return msg ? `${name}: ${msg}` : name
}
export const newNotFound = (msg: string) => new MyError(404, msg)
export const newValidation = (msg: string) => new MyError(400, msg)
export const newConflict = (msg: string) => new MyError(409, msg)
export const newInternal = (cause: unknown) => new MyError(500, describe(cause))
```

**使用规则**：
- **400 校验错误**：`NewValidation`（文案 = 现有契约文案，逐字不变，小写开头）。
- **404**：`NewNotFound`；**409**（import 唯一约束/重名，暂未用）：`NewConflict`。
- **驱动错误（DB/网络）**：`NewInternal(err)`——`describe` 拼 `%T: msg`（Go）/ `constructor.name: msg`（Node），500 detail 透传驱动消息（AGENTS「500 透传驱动错误」，双端各自真实不强求一致）。
- **行数/状态类竞态错误**（transition `RowsAffected != 1`）：`NewInternal`。
- 三层一律经 myerr，**禁止再裸 `fmt.Errorf`/`new Error` 抛业务/驱动错误**（驱动错误只在 NewInternal 内部被 describe 消费）。

## 2. 现状三层盘点（改造前）

| 层 | Go | Node |
|---|---|---|
| Repository | `recordrepo`：`record.ErrNotFound` 哨兵（`%w` 链）、裸 pgx 错误、`fmt.Errorf("todo update affected %d rows")` | `recordrepo.ts`：`RecordNotFoundError`、裸 drizzle/postgres 错误、`new Error("todo update affected N rows")` |
| Service/业务 | logapi/importapi/exportapi/query：`(T, status, error)` 元组；400 裸 err；`errors.Is` 映射 404/500；importapi 用 `StatusOf(err)` 辅助；query 用 `ErrInvalidTZ` 哨兵 | logapi.ts/importapi.ts：`{error, status}` 返回对象（38 处 status 字面量）；`RecordNotFoundError` instanceof |
| Handler | httpx/server.go：`writeLogOrError`（<500→writeError；≥500→writeInternalError）、`writeInternalError`、`errorDetail`（空消息 %T 兜底）；各 handler 4xx 预分支（`errors.Is ErrInvalidTZ`、`importapi.StatusOf`、`ValidateRename`、`Parse*Params`） | 12 个 route：`'error' in result` → `errorResponse(result.error, result.status)`；catch → `errorResponse(errorMessage(error), 500)` |

**业务函数签名现状（Go）**：`CreateText(ctx, pool, body) (record.Record, int, error)`；`CreateTransactionBatch(...) (int, string, string, []record.Record, int, error)`——6 元组。

## 3. 改动范围（双端文件清单）

### Go
| 文件 | 改动 |
|---|---|
| `faas/internal/myerr/myerr.go` | **新建**：MyError + 4 个 NewXXX + describe |
| `faas/internal/recordrepo/repository.go` | FindByID ErrNoRows→`NewNotFound`；其余裸 err→`NewInternal`；Transition RowsAffected!=1→`NewInternal` |
| `faas/internal/logapi/*.go`（7 函数） | 签名 `(T, status, error)`→`(T, error)`；400→`NewValidation(err.Error())`；404→`NewNotFound`；500→`NewInternal(err)`；删 errors.Is 映射 switch |
| `faas/internal/importapi/importapi.go` | `StatusOf` 删除（status 由 myerr 自带）；内部 `fail(400, ...)`→`NewValidation`；驱动→`NewInternal` |
| `faas/internal/exportapi/exportapi.go` | `ErrExportFromNotFound`→`NewNotFound`；500→`NewInternal` |
| `faas/internal/query/query.go` | `ErrInvalidTZ` 哨兵→`NewValidation`；`ParseRecordQueryParams` 裸 err→`NewValidation`；驱动→`NewInternal` |
| `faas/internal/httpx/server.go` | handler 统一：`errors.As(err, &me)` → `writeError(w, me.Status, me.Error())`；非 MyError→500 兜底；日志按 `me.Status >= 500` 分级；删 `writeLogOrError`/`writeInternalError`/`errorDetail`/`StatusOf` 分支 |
| `faas/internal/record/record.go` | 删 `ErrNotFound`/`ErrInvalidID` 哨兵（如无其他引用）；`ErrInvalidID`→`NewValidation` |

### Node
| 文件 | 改动 |
|---|---|
| `src/lib/myerr.ts` | **新建**：MyError + 4 个 newXXX + describe |
| `src/lib/recordrepo.ts` | findById 未找到→`throw newNotFound`（或返回 myerr）；transition RowsAffected!=1→`newInternal`；驱动→`newInternal` |
| `src/lib/logapi.ts` | 业务函数 `{error, status}` 对象→`throw`；38 处 status 字面量→newXXX；`LogApiError` 类型删除 |
| `src/lib/importapi.ts` / `exportapi.ts` / `query.ts` | 同 logapi |
| `src/lib/record/errors.ts` | `RecordNotFoundError` 类删除（或并入 myerr） |
| `src/app/api/**/route.ts`（13 个业务 route：log 6 + admin 3 + export 1 + query 3） | `'error' in result`→try/catch `instanceof MyError` → `errorResponse(err.message, err.status)`；catch 兜底 500；telegram/qqbot/db/time probe 4 个不涉及 |

### 测试（双端，随各层一起改）
- `faas/internal/recordrepo/repository_test.go`、`faas/internal/logapi/*_test.go`（15 文件）、`faas/internal/httpx/*_test.go`
- `src/lib/*.test.ts`、`src/lib/logapi.number-rollback.test.ts` 等

## 4. 验收方案

每层改完各自验证；最后跑全局守卫 + 全量测试门闸。

### 4.1 Repository 层验收

**行为断言**（Go 单测 `repository_test.go`）：
- FindByID 未找到：`res.Error` 为 `*myerr.MyError`，`.Status == 404`，`.Error()` 含记录 id 与 `not found`。
- 驱动错误（fake row 注入 `pgx.ErrNoRows` 之外错误）：`*myerr.MyError` 且 `.Status == 500`，`.Error()` **contains** 注入的驱动消息（`strings.Contains`，不逐字——describe 前缀格式不属于契约）。
- Transition RowsAffected != 1：`*myerr.MyError`，Status 500，`.Error()` 含 `todo update affected 2 rows`。

**Node 对应**（`recordrepo` 测试）：`err instanceof MyError`、`err.status`、`err.message` contains 注入消息。

### 4.2 Service 层验收

**编译期**：签名 `(T, error)` 无 status——`go build` 即验证。

**行为断言**（logapi 单测）：
- 400：校验错误 → `err` 为 `*myerr.MyError`，`.Status == 400`，`.Error()` **逐字等于**原契约文案（`NewValidation` 文案不变，现有断言基本可沿用，只改断言对象）。
- 404：`TodoNotFound` 等 → Status 404。
- 500：fake tx 注入驱动错误 → Status 500，`.Error()` contains 驱动消息（沿用 `number_rollback_test.go` 的注入，把 `err.Error() != "injected insert failure"` 改为 `contains`）。
- **grep 守卫**：`rg "errors.Is\(res.Error, record.ErrNotFound\)" faas/internal` → **0 命中**（映射 switch 全删）；`rg ", 4[0-9][0-9], err" faas/internal/logapi` → 0 命中。

**Node**：`await expect(fn()).rejects.toMatchObject({ status: 400, message: '...' })`（throw 形态）。

### 4.3 Handler 层验收

**行为断言**（httpx httptest）：
- 每个写路径 handler 的成功用例不变（status 200/201 + body 形状）。
- 错误用例：注入/构造对应 myerr，断言响应 status 正确 + detail（用现有 `assertProblemDetailContains`，httpx/problem_test.go:34）。
- **500 兜底**：注入非 MyError 错误（`errors.New("boom")`）→ 响应 500 + detail 为 `*errors.errorString: boom`（describe 前缀），日志记 `slog.Error`。该测试是"漏包装兜底"的守卫。
- **日志分级**：`me.Status >= 500` → `slog.Error`；400 → `slog.Info`（spy/肉眼验证，不强制单测）。
- `TestWriteInternalErrorTransmitsDetail`：逐字断言改为 `assertProblemDetailContains(rr, "ERROR: relation ...")`。

**Node**：route 测试断言 `response.status` 与 body detail；`instanceof MyError` 分支正确走 status；catch 兜底 500。

### 4.4 全局守卫（确保全部改完）

改完统一跑，期望全部 0 命中（Go）：
```bash
rg "writeLogOrError|writeInternalError|errorDetail" faas/internal/httpx
rg "errors.Is\(res\.Error" faas/internal/
rg ", 4[0-9][0-9], err|, 404, err|, 500, err" faas/internal/logapi faas/internal/exportapi
rg "record\.ErrNotFound|record\.ErrInvalidID|ErrExportFromNotFound|ErrInvalidTZ" faas/internal/ --glob '!*_test.go'
rg "fmt\.Errorf\(" faas/internal/myerr faas/internal/recordrepo   # 仅 myerr.describe 内部允许
```
Node：
```bash
rg "status: 4|status: 5" src/lib/logapi.ts src/lib/importapi.ts      # 0 命中
rg "errorResponse\(result\.error|LogApiError|RecordNotFoundError" src/
rg "new Error\(" src/lib/recordrepo.ts src/lib/logapi.ts             # 仅非业务驱动路径
```

### 4.5 测试门闸（全量）
```bash
go build ./... && go vet ./... && ~/go/bin/golangci-lint run ./...
go test -short -count=1 ./...
npm run typecheck && npm run lint && npm run test:unit
npm run test:integration        # 双端 API 集成
```

## 5. 落地顺序建议

- **D1（独立、小、先做）**：新建 `myerr` 包 + handler 500 兜底统一（`errors.As` + `writeError(w, me.Status, ...)`）+ `NewInternal` describe；删 `writeInternalError`/`writeLogOrError`/`errorDetail`。**不碰业务函数签名**，立即获得 500 detail 带类型名的诊断收益。
- **D2（大，与步骤 9 Service 化合并）**：业务函数 `(T, status, error)`→`(T, error)` + 全层换装 + Node 端 throw 化。与 Service 化同波改签名，避免同一批函数碰两遍。

## 6. 相关记录

- 错误响应形状（RFC 9457 problem+json）：[`docs/20260805-error-response-shape.md`](20260805-error-response-shape.md)。
- 内部错误透传（阶段 A 已完成 + 阶段 B ErrInternal 规划）：[`docs/20260806-internal-error-transparency.md`](20260806-internal-error-transparency.md)。
- UoW + Repository 架构终稿（§4 错误形态、步骤 6-9）：[`docs/20260806-uow-repository-architecture.md`](20260806-uow-repository-architecture.md)。
- Go 代码质量规范（错误链 / ST1005 / 日志）：[`docs/20260805-go-code-quality.md`](20260805-go-code-quality.md)。
