# 内部错误透传改造：现状分析与策略

> 创建日期：2026-08-06
> 性质：分析 + 策略文档。针对「底层错误被合并成固定文案 `Internal server error`」的现状问题，给出改造策略。
> 触发：UoW+Repository 审查（A2/A3 领域错误体系）讨论中，用户指出 500 出口「把本可拿到的实际错误信息换成固定文案」是反设计——违背设计哲学 §2.1（AI 诊断权）与 RFC 9457 `detail` 字段语义。

## 1. 问题定义

- **合并**：底层错误（领域错误 / 三方库驱动错误）在 500 出口被统一合并为 `Internal server error`——与领域错误体系「保留具体性」的初衷自相矛盾（设计了具体错误类，却在出口抹平）。
- **detail 误用**：RFC 9457 `detail` 定义是「特定于本次发生的具体解释」，`title` 才是问题类型摘要（`statusTitle(500)` 已给 `Internal Server Error`）——现状 `detail` 与 `title` 重复，且丢弃了本可承载的具体错误。
- **违背 AI 诊断权**：AI 是全权操作者，需看到实际错误（磁盘满 / 连接超限 / 查询失败 message）才能诊断与行动（设计哲学 §2.1）。

## 2. 现状分析

### 2.1 Go

```go
// faas/internal/httpx/server.go
func writeInternalError(w http.ResponseWriter, _ error) {   // ← err 被丢弃
	writeError(w, http.StatusInternalServerError, "Internal server error")
}
```
- `writeLogOrError`：`status >= 500` → `slog.Error(logMsg, "err", err)` + `writeInternalError`（细节进日志，detail 固定）。
- handler 直接调用 `writeInternalError` 共 **7 处**（query / summary / tags / rename / transactions-summary / import 等）。

### 2.2 Node

- 各 route `catch`：`return errorResponse('Internal server error', 500)`（**15 处**，均已改为 `errorMessage(error)`）。
- `logapi.ts` / `importapi.ts` 内部：`return { error: 'Internal server error', status: 500 }`（**8 处**——logapi 7 + importapi 1）——catch 后同样把 `err` 换成固定文案。

### 2.3 守卫测试

```go
// server_test.go TestWriteInternalErrorNeverExposesDetails
t.Setenv("EXPOSE_ERRORS", "1")
writeInternalError(rr, errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`))
if body["detail"] != "Internal server error" { t.Fatalf("leaked internal detail") }
```
- 故意设 `EXPOSE_ERRORS=1` 也断言不透传——**固化反设计**的防回归守卫，应反转。

### 2.4 OpenAPI / fixtures / AGENTS

- `responses.yaml#/InternalError` example：`detail: Internal server error`（与 `title: Internal Server Error` 重复）。
- fixtures：`error-*.json` 无 500 项（不受影响）。
- AGENTS 错误文案规范：`Internal server error` 列为固定文案例外。

### 2.5 历史动机（推测）与否定

| 动机 | 分析 | 结论 |
|---|---|---|
| 传统安全（内部错误不泄漏） | 个人系统 + AI 唯一操作者，威胁模型低；设计哲学 §2.1 已定安全让位于 AI 诊断权 | 不成立 |
| 可测试性（固定值好断言） | 三方库 message 不确定、双端不一致 → 固定文案好测——**测试策略反过来决定设计，本末倒置**；正确做法是 mock 测行为 | 不成立 |

## 3. 策略（统一领域错误模型）

### 3.1 目标

**消除「内部错误」特殊通道**——三方库错误（pgx / postgres.js）在底层被**吸收**为系统自己的领域错误 `ErrInternal`（message = 原始三方库错误内容），上层所有错误都是领域错误，status 由业务函数显式返回（A2 定案，无 statusOf）。`writeInternalError` 特殊通道与 `writeLogOrError` 删除：日志拆为独立 `logResponseError(status, logMsg, err)`（仅 ≥500 记录），响应统一 `writeError(w, status, err.Error())`——`detail` 透传原始内容（AI 诊断权，设计哲学 §2.1）。

### 3.2 统一错误模型（防腐层思想）

```
三方库错误（pgx / postgres.js）
  → Repository 层吸收，包装为领域错误 ErrInternal（保留原始 err，Unwrap 保链）   ← 防腐层（唯一碰 SQL 的层）
  → 业务层 / handler：所有错误都是领域错误，status 由业务函数显式返回（A2 定案，无 statusOf）
  → handler：logResponseError(status, logMsg, err) + writeError(w, status, errorDetail(err))   ← 无 writeInternalError
```

| 领域错误 | status |
|---|---|
| `ErrNotFound` | 404 |
| `ErrConflict` | 409 |
| `ErrValidation` | 400 |
| **`ErrInternal`**（message = 原始三方库错误） | **500** |

### 3.3 Go 形态

```go
// record/errors.go —— ErrInternal 领域错误（保留原始三方库错误，不合并不丢弃）
// 存原始 err + Unwrap：Error() 返回原文，errors.As 命中 InternalError，底层链仍可 errors.Is 穿透
type InternalError struct{ err error }
func (e *InternalError) Error() string { return e.err.Error() }
func (e *InternalError) Unwrap() error { return e.err }
func ErrInternal(err error) error {
	if err == nil {
		return nil
	}
	return &InternalError{err: err}
}

// Repository：唯一碰 SQL 的层，在此吸收三方库错误（防腐层）
func (r *RecordRepository) SaveAll(ctx, q, records) SaveAllResult {
	var res SaveAllResult
	err := q.Exec(...)
	if err != nil {
		res.Error = record.ErrInternal(err)   // 三方库错误 → 领域错误
		return res
	}
	...
}

// statusOf：~~统一映射（替代 writeInternalError 分支）~~ 已否决——方案 A 定案：status 由业务函数显式返回（A2），不引入 statusOf。

// handler：统一，无 writeInternalError（status 来自业务函数，err 透传）
result, status, err := service.AttachTag(ctx, s.Pool, id, tag)
if err != nil {
	writeError(w, status, err.Error())
	return
}
```

### 3.4 具体改动清单

1. **Go**：`record` 包新增 `ErrInternal`（`InternalError` 类型 + `ErrInternal(err)` 包装）；Repository 层吸收三方库错误；**status 来源保持 A2 定案（业务函数显式返回，不引入 statusOf）**；删除 `writeInternalError` 特殊通道（handler 统一 `logResponseError + writeError(w, status, errorDetail(err))`）。
2. **Node**：见 §3.5（双端对称，但当前无 Repository 层，见下）。
3. **守卫测试反转**：`TestWriteInternalErrorNeverExposesDetails` → 验证 500 + detail 透传。
4. **OpenAPI** `InternalError` example 更新（示意透传具体错误）。
5. **AGENTS**：移除 `Internal server error` 固定文案例外（500 detail 不再固定，空 message 时以 `%T` 类型名兜底）；「双端逐字一致」适用范围明确为仅契约文案（我们写的），透传驱动错误不在其内。
6. **双端 message 差异**：接受（pgx vs postgres.js 格式不同），不强求统一——统一才是信息丢失。

### 3.5 Node 形态（当前阶段）

- Node 现状**无 Repository 层**（UoW 架构暂停中），三方库错误由 `logapi` / 各 route 的 `catch` 直接吸收。
- 当前落地：catch 统一透传 message（抽 `errorMessage(error)` helper 处理 `unknown` → string）：

```ts
// src/lib/errors.ts（或现有公共 helper）
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// logapi / route catch
} catch (error) {
	logger.error({ err: error }, '...')
	return { error: errorMessage(error), status: 500 }   // 透传，不合并
}
```

- **`InternalError` 类留到 UoW 落地时引入**（与 Repository 一起）：届时 `class InternalError extends Error` 与 Go `ErrInternal` 对称，Repository 吸收三方库错误，业务层 `instanceof InternalError` → 500。当前 Result 已带 status，无判别需求，引入类纯为铺路——故推迟。

**Node 改动清单（当前阶段）**——✅ **已实施**（`errorMessage` 放 `src/lib/httperror.ts`，与 Go `errorDetail` 对称）：
1. 新增 `src/lib/errors.ts` → **实际放 `httperror.ts`**：`errorMessage(error: unknown): string` helper（`error instanceof Error ? error.message : String(error)`）。
2. `logapi.ts` / `importapi.ts`：**8 处** `{ error: 'Internal server error', status: 500 }` → `{ error: errorMessage(err), status: 500 }`。
3. 各 route `catch`：**15 处** `errorResponse('Internal server error', 500)` → `errorResponse(errorMessage(error), 500)`。
   - **注意区分**：仅 500 通用 catch 透传；`catch` 无参数分支（如 telegram/qqbot 畸形 JSON → 400 业务错误）不属于本改造。
4. **测试**：mock 单测可断言精确 message（`logapi.transition.test.ts` mock `new Error('audit insert failed')` → `error: 'audit insert failed'`）；真 DB 集成测试放宽为 `status=500` / `detail` 非空（不断言具体值）。
5. `InternalError` 类推迟（UoW 落地时与 Repository 一起引入，见上）。

### 3.6 Go 端落地细节（讨论中）

1. **阶段划分**：当前**无 Repository 层**（UoW 暂停），业务函数直接返回 `(T, status, error)`（err 为含三方库错误的包装链）。分两阶段：
   - **阶段 A（现在）**：最小透传——`writeInternalError` 改为 `writeError(w, 500, err.Error())`（透传），守卫测试反转。统一模型的**中间态**。
   - **阶段 B（UoW 落地时）**：引入 `ErrInternal` 类 + Repository 层吸收三方库错误（防腐层）——`writeInternalError` 消失。与 Node 端「`InternalError` 类推迟」决策对称。
2. **statusOf 已否决（方案 A 定案）**：status 来源保持 A2 定案——业务函数显式返回 `(T, status, error)`，handler 用业务函数给的 status。**不引入** statusOf 统一映射（双端对称：Node `Result.status` 亦保留）。领域错误分类（400/404/409/500）在业务函数内完成。
3. **`ErrInternal` 错误链保留**：`InternalError` 存原始 `err` + 实现 `Unwrap()`（返回原 err）——`Error()` 返回原文，`errors.As` 命中 `InternalError`，底层链仍可 `errors.Is` 穿透（如判 SQLSTATE）。**不**只存 `message` 断链。
4. **`writeLogOrError` 删除（已定案）**：拆为独立日志方法 `logResponseError(status int, logMsg string, err error)`（仅 `status >= 500` 时 `slog.Error(logMsg, "err", err)`）+ 调用者显式 `writeError(w, status, errorDetail(err))`。handler 出错分支显式组合：
   ```go
   if err != nil {
   	logResponseError(status, "Error creating number records", err)
   	writeError(w, status, errorDetail(err))
   	return
   }
   ```
   日志语义随操作走（8 处 handler 各自组合），无跨层依赖。
5. **日志位置**：500 时 `slog.Error(logMsg, "err", err)` 保持（写路径 handler 显式调用 `logResponseError`、读路径 handler 内 `slog.Error`）——日志是诊断兜底，与透传并存。
6. **守卫测试 + 空 err 兜底**：`TestWriteInternalErrorNeverExposesDetails` → `TestWriteInternalErrorTransmitsDetail`（500 + 透传注入 message）。空 message 兜底用 `errorDetail(err)` helper：`err.Error() == ""` 时以 `fmt.Sprintf("%T", err)` 类型名兜底（非 nil error 永不为空，保留诊断信息）——阶段 B 删除 `writeInternalError` 后由其承担（与 Node `errorMessage` helper 对称）：
   ```go
   func errorDetail(err error) string {
   	if msg := err.Error(); msg != "" {
   		return msg
   	}
   	return fmt.Sprintf("%T", err)
   }
   ```
   handler：`logResponseError(status, logMsg, err)` + `writeError(w, status, errorDetail(err))`。

## 4. 待验证 / 风险

- **Go pgx vs Node postgres.js 实际错误 message 差异**：实施时对比（如 `relation ... does not exist`、`disk full` 在两端的实际输出），确认透传后 detail 形态。
- **detail 长度 / 可读性**：`err.Error()` 可能较长（含驱动前缀 / SQLSTATE）；评估是否需要提取可读摘要（倾向先透传原文，视实际效果再定）。
- **契约影响**：detail 不再固定 → OpenAPI `InternalError` example、相关断言、AGENTS 例外需同步（改动清单 4/5）。
- **Node catch 类型**：`unknown` → `errorMessage` helper 统一处理（§3.5）。
- 不改 fixtures（无 500 项）。

## 5. 相关记录

- 设计哲学 §2.1 推论：错误信息透传（AI 诊断权）：`docs/20260805-design-philosophy.md`
- 领域错误体系（XXXXResult / 领域错误类）：`docs/20260806-uow-repository-architecture.md` §4
- RFC 9457 `detail` / `title` 语义：`docs/20260805-error-response-shape.md`
