# 内部错误透传改造：现状分析与策略

> 创建日期：2026-08-05
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
- handler 直接调用 `writeInternalError` 约 8 处（query / summary / tags / rename / import 等）。

### 2.2 Node

- 各 route `catch`：`return errorResponse('Internal server error', 500)`（约 20 处）。
- `logapi.ts` / `importapi.ts` 内部：`return { error: 'Internal server error', status: 500 }`（9 处）——catch 后同样把 `err` 换成固定文案。

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

## 3. 策略

### 3.1 目标

500 出口**透传实际错误信息**（detail = 具体错误），保留具体性；`status=500` + `title=Internal Server Error`（reason phrase）继续表达「内部服务器错误」类型语义。

### 3.2 分层原则（消息来源 → 一致性要求）

| 消息来源 | 双端一致 | 测试方式 |
|---|---|---|
| **领域错误**（我们写：`record not found` 等） | ✅ 必须（契约） | 精确 message 断言 + 双端一致契约测试 |
| **透传三方库错误**（pgx / postgres.js） | ❌ 不强求（不同驱动天然不同，各自真实） | **mock** 驱动错误，测「透传发生 + 500」，不断言三方 message 具体值 |

### 3.3 具体改动清单

1. **Go** `writeInternalError`：`writeError(w, http.StatusInternalServerError, err.Error())`——透传，不合并。
2. **Node** route catch：`errorResponse(err.message, 500)`；`logapi.ts` / `importapi.ts` 内部：`return { error: err.message, status: 500 }`。
3. **守卫测试反转**：`TestWriteInternalErrorNeverExposesDetails` → `TestWriteInternalErrorTransmitsDetail`（断言 status=500 + detail 透传了注入的错误）。
4. **OpenAPI** `InternalError` example 更新（示意透传具体错误，如 `disk full (SQLSTATE 53100)`）。
5. **AGENTS**：错误文案规范移除 `Internal server error` 固定例外的适用面（title 保持 reason phrase，detail 透传）；「双端逐字一致」适用范围明确为**仅契约文案（我们写的）**，透传驱动错误不在其内。
6. **双端 message 差异**：接受（pgx vs postgres.js 格式不同），不强求统一——统一才是信息丢失。

## 4. 待验证 / 风险

- **Go pgx vs Node postgres.js 实际错误 message 差异**：实施时对比（如 `relation ... does not exist`、`disk full` 在两端的实际输出），确认透传后 detail 形态。
- **detail 长度 / 可读性**：`err.Error()` 可能较长（含驱动前缀 / SQLSTATE）；评估是否需要提取可读摘要（倾向先透传原文，视实际效果再定）。
- **契约影响**：detail 不再固定 → OpenAPI `InternalError` example、相关断言、AGENTS 例外需同步（改动清单 4/5）。
- 不改 fixtures（无 500 项）。

## 5. 相关记录

- 设计哲学 §2.1 推论：错误信息透传（AI 诊断权）：`docs/20260805-design-philosophy.md`
- 领域错误体系（XXXXResult / 领域错误类）：`docs/20260805-repository-architecture-review.md` A2 / A3
- RFC 9457 `detail` / `title` 语义：`docs/20260805-error-response-shape.md`
