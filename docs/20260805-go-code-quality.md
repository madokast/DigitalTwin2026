# Go 代码质量规范

> 创建日期：2026-08-05
> 性质：Go 侧代码质量规范与待办清单。收录不符合业界惯例的问题与永久规范：错误链 `%w`、禁止 map/any jsonify、结构化日志 slog、状态码常量、handler 样板收敛、race 检测、golangci-lint。
> 触发：UoW + Repository 架构审查（`docs/20260805-repository-architecture.md`）时发现 Go 侧多处不符合业界惯例；其中「禁止 map/any jsonify」为**永久规范**（key 顺序问题，AI 读响应字符串会很奇怪）。

## 1. Go 错误链 `%w`（✅ 已实现，`273041f`）

### 现状

- 全仓 **48 处** `fmt.Errorf("%s", ...)` / `fmt.Errorf("%s%s", prefix, err.Error())`，仅 **3 处** `%w`。
- 效果：错误被「拍平」为字符串，`errors.Is` / `errors.As` 无法判等，日志无法追溯根因。
- 典型案例：`fmt.Errorf("%s", tv.Error)`、`fmt.Errorf("%s", tododraft.ErrTodoNotFound)`、`fmt.Errorf("%s%s", prefix, err.Error())`。

### 目标改法（API 文案完全不变）

| 现状 | 改后 |
|---|---|
| `const ErrTodoNotFound = "to-do not found"` | `var ErrTodoNotFound = errors.New("to-do not found")` |
| `fmt.Errorf("%s", tododraft.ErrTodoNotFound)` | `fmt.Errorf("%w", tododraft.ErrTodoNotFound)` |
| `fmt.Errorf("%s", tv.Error)`（tv.Error 是 string） | `fmt.Errorf("%w", errors.New(tv.Error))` |
| `fmt.Errorf("%s%s", prefix, err.Error())` | `fmt.Errorf("%s%w", prefix, err)` |

- 外层错误消息字符串不变（`%w` 无前缀时消息即内层 Error()；带前缀时 `%s%w` 拼接同现状）→ **HTTP 契约文案零变化，双端一致不破坏**。
- 字符串常量改 `errors.New` 哨兵后，测试可从 `err.Error() != want` 升级为 `errors.Is(err, ErrTodoNotFound)`（可保留字符串断言作补充）。
### 改造纪律（关键）

- **Go 错误消息 = API 契约文案**：`writeError(w, status, err.Error())` 直接输出 Go error 为 HTTP `error` 字段，Node 端**逐字一致**。
- **契约文案已标准化为小写开头**（ST1005 改造，见「§7 探测结果」）：所有错误文案首字母小写（`Missing required field` → `missing required field`），双端同步。**新增错误文案必须小写开头 + 双端逐字一致**（staticcheck ST1005 作为守卫拦截新的大写文案）。
- 例外（保持大写，staticcheck 不报）：`Unknown JSON key`（常量前缀）、`Internal server error`（固定 500 文案）——双端各自一致即可。
- `%w` 改造 **只改机制**：`%s`→`%w`、string 常量→`errors.New`（**同文案**）——**文案字符串逐字不动**。
- 区分两类错误：
  - **契约错误（400/404/409）**：`writeError` 输出 `err.Error()` → 文案锁定，只改 wrap 机制。
  - **内部错误（500）**：`writeInternalError` 忽略 err（客户端只见固定 `Internal server error`）→ 内部 err 可自由 `%w` 增强日志，不影响契约。

### 影响面

- 涉及文件：`logapi`（number/text/todo/bodyweight/review/transaction）、`tododraft`、`transactiondraft`、`numberdraft`、`bodyweightdraft`、`reviewdraft`、`draft`、`tags`、`query`、`importapi`、`httpx`、`recordjsonl` 等。
- 纯内部改造：无 OpenAPI / Node 侧改动，测试全绿为完成标准。

## 2. 禁止 map/any jsonify（永久规范）

### 原因

Go 的 `encoding/json` 序列化 `map[string]any` 时 **key 按字母序排序**（非插入序）。`{"success": true, "inserted": 2, "type": "expense"}` 实际输出 `{"inserted":2,"success":true,"type":"expense"}`。HTTP 语义无影响，但 **AI 客户端读响应字符串会因 key 顺序随机而困惑**；map 也失去编译期类型检查。

### 规范（永久）

> **禁止对 `map` 或 `any` 直接 jsonify**。HTTP 响应一律用 **typed struct**（字段 `json:"snake_case"`，保插入序）或已有的 typed 值（`result`/`body` struct）。

### 现状（已实现，`faas/internal/httpx/responses.go`）

- ✅ **15 处 handler 响应已改 typed struct**：`NumberBatchSuccess` / `TransactionBatchSuccess` / `RecordSuccess` / `TodoRecordSuccess` / `TransitionSuccess` / `QuerySuccess` / `SummarySuccess` / `TimeSuccess` / `TagsSuccess` / `RenameTagsSuccess` / `ImportRecordsSuccess` / `SuccessOnly` / `ErrorResponse`——字段声明序即 JSON key 序，符合「统一模板」。
- ✅ `writeError` / 401 / import 均走 typed struct（错误响应形状仍为 `{error}`，RFC 9457 改造时一并换 `ErrorResponse`）。

### 改法

为每个响应形状定义 typed struct（如 `CreateBatchResponse{Success bool `json:"success"`; ...}`），或复用已有 struct；`writeJSON` 仍收 `any`，但调用处只传 typed 值。

### key 顺序（双端对齐，可读性规范）

Go typed struct 的 **JSON key 顺序 = 字段声明顺序**（`encoding/json` 按声明序输出，json tag 不影响顺序）；Node `JSON.stringify` 按对象**属性插入顺序**。双端响应须按同一模板排列，使 AI 读响应字符串顺序稳定。

**统一模板**（自上而下）：

| 类别 | key 顺序 |
|---|---|
| 通用 | **`success` 恒第一位** |
| 有 `id` 的 | `success` → **`id`（第二位）** → 其余 |
| 批量 create | `success` → `inserted` → 业务字段 → `atomic`（numbers：`success, inserted, atomic`；transactions：`success, inserted, type, sum, atomic`） |
| 单条 create | `success` → `record`（record 内部序见下） |
| record 实体 | `id` → `happened_at` → `numeric_value`（null 省略）→ `raw_content` → `objective_context` → `ai_analysis` → **`tags`（最后）** |
| todo 变形（record） | `id` → `created_at` → `content` → `objective_context` → `ai_analysis` → **`tags`（最后）**（query `records[]` 元素同形） |
| query records | `success` → `count` → `page` → `page_size` → `sort_by` → `sort_order` → `records` → `hint`（可选，末尾追加） |
| query tags | `success` → `tags` |
| transactions summary | `success` → `from` → `to` → `income` → `expense` → `net` → `income_categories` → `expense_categories` |
| stats | `success` → `total` → `today` → `tz` |
| time | `success` → `now` → `tz` |
| todo transition | `success` → `id` → `transition{from, to}` |
| rename | `success` → `updated` |
| probe | `success` |

**纪律**：
- Go 用 typed struct，**字段声明序 = 上表顺序**（Node 对象属性序同表）——新增/修改响应时双端按表对齐。
- 禁止 map（字母序乱序）、避免**嵌入字段**（embedded 序列化顺序特殊）。
- key 顺序**非契约强制**（JSON 语义无序，契约测试无序比较）——纯可读性规范，但长期维护下统一。
- 错误响应（RFC 9457 改造后）单独模板：`title` → `status` → `detail`（见 `docs/20260805-error-response-shape.md`）。

### 优先级

- 低优先（可后置），但与 `docs/20260805-error-response-shape.md`（错误响应结构化）合并实施——错误响应本身就是 `map[string]string{"error"}`，一起改 typed。

## 3. 结构化日志 `log/slog`（✅ 已实现，`ecbc9c0`；Node 对应 pino `7dfb1a3`，规范见 AGENTS.md「日志」）

### 现状

- 全仓 `log.Printf`（标准库 log）。Go 1.21+ 业界推荐 `log/slog`（结构化键值对、可接采集）。

### 目标

- 服务启动 / handler 错误日志改 `slog`：`slog.Error("create transaction failed", "err", err, "path", r.URL.Path)`。
- 保持**用户可见文案英文**（AGENTS.md 语言原则）；日志属 stdout/stderr，用英文。

### 优先级

- 低优先，独立小改造；不阻塞错误链与 JSON 组装。

## 4. 魔法数字 HTTP 状态码（✅ 已实现，`5c1c3b1`）

### 现状

- `faas/internal/httpx/server.go` 大量数字字面量：`writeError(w, 400, ...)`、`writeJSON(w, 200, ...)`、`writeInternalError(w, err)`（500）。统计 37 处。
- 数字字面量可读性差，且手滑难查（`405` vs `403`、`401` vs `400`）。

### 目标

- 一律用 `net/http` 常量：`http.StatusOK`、`http.StatusCreated`、`http.StatusBadRequest`、`http.StatusUnauthorized`、`http.StatusNotFound`、`http.StatusConflict`、`http.StatusRequestEntityTooLarge`（413）、`http.StatusInternalServerError`。
- 业务层 `status int` 返回值（`logapi` 的 400/404/409/500）——为跨层简单可保留数字，但 **handler 出口统一用 `http.StatusXxx` 常量**。

### 优先级

- 纯机械重构，测试全绿即完成；与 §5（错误样板收敛）合并。

## 5. handler 错误处理样板重复（✅ 已实现，`59b12ae`）

### 现状

每个写 handler 重复同一段：

```go
if err != nil {
    if status >= 500 {
        log.Printf("Error creating ...: %v", err)
        writeInternalError(w, err)
        return
    }
    writeError(w, status, err.Error())
    return
}
```

统计 8 处 `if status >= 500`（number/text/todo/bodyweight/review/transaction/import 等）。

### 目标

抽公共 helper（含 §4 状态码常量）：

```go
// 契约错误（<500）直接 writeError；内部错误（>=500）记日志 + writeInternalError。
func writeLogOrError(w http.ResponseWriter, status int, err error, logMsg string)
```

- `logMsg` 为英文日志前缀（保持现状 `Error creating ...`）；日志内部走 `%w` 链（`log.Printf("%s: %v", logMsg, err)`）。
- 各 handler 收敛为一行 `writeLogOrError(w, status, err, "Error creating number records")`。

### 优先级

- 与 §4 一起；纯重构，测试全绿即完成。

## 6. `go test -race`（✅ 已实现）

### 现状

- CI（`.github/workflows/ci.yml`）与本地 scripts 均未跑 `go test -race`。
- 风险：`go s.notify()` 协程 + `Server` 字段并发读写（`s.Now()` / `s.NotifyUser`）可能有 data race 未被发现。

### 目标

- `scripts/test-unit.ts` / CI 的 Go 测试命令加 `-race`（`go test -race -short ./...`）。
- 集成测试（httptest + 真 DB）同样可加 `-race`（成本略高，可只对 unit）。

### 优先级

- 低成本（改命令），立即纳入；发现 race 则修复。

## 7. golangci-lint（✅ 已实现：`.golangci.yml` + CI job；ST1005/ST1012/S1017/S1016 全清零）

### 现状

- CI 仅 `go vet` + `go build` + `go test`。业界常用 golangci-lint（聚合 staticcheck / errcheck / gocritic / ineffassign / unused 等）。
- 本仓库 11 处 `_ = tx.Rollback` / `defer rows.Close()` 忽略错误（defer 清理 best-effort，业界可接受；errcheck 默认会报，需豁免）。

### 探测结果（staticcheck 2025.xx）

| 代码 | 数量 | 性质 | 处理 |
|---|---|---|---|
| `ST1005`（error 字符串大写） | 55（已清零） | API 契约文案 | **已标准化为小写开头**（双端同步 + fixtures/测试/OpenAPI）——不再豁免，作 lint 守卫 |
| `ST1012`（error var 命名 `ErrFoo`） | 13（已清零） | 哨兵命名 | **已重命名**加 `Err`/`err` 前缀（`e53ae9c`）——不再豁免 |
| `S1017`（`TrimPrefix`/`TrimSuffix` 简化） | 2 | 可重构（importapi.go:160、recordjsonl.go:75） | **修复** |
| `S1016`（struct literal → 直接转换） | 1 | 测试代码（query/transactions_summary_test.go:96） | **修复** |

**关键设计**：ST1005 / ST1012 已通过**真正解决**（文案小写化 + 哨兵重命名）清零，`.golangci.yml` **无需豁免**——二者作为 lint 守卫拦截新的大写文案 / 非 `Err*` 命名。

### 方案（定案）

1. **安装**：golangci-lint（CI 用官方 action `golangci/golangci-lint-action`；本地 `go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest`）。
2. **`.golangci.yml`**：
   - linters：default（govet / errcheck / ineffassign / unused / staticcheck / gocritic 等）
   - **无需豁免 ST1005 / ST1012**（已清零，作守卫）
   - **errcheck**：豁免 defer 清理类（`_ = tx.Rollback` / `defer rows.Close()`）——用 `exclude-functions` 或文本排除
3. **修复**：S1017×2 + S1016×1（小重构）。
4. **CI**：加 `golangci-lint run` job（与 unit-go 并行）。
5. **回归**：全量 unit + integration + lint。

### 优先级

- 剩余 Go 质量问题最后一项；实施后 Go 侧全部问题清单（§1-§7）收尾，仅剩 RFC 9457（§8，独立破坏性）。

## 8. 错误响应 RFC 9457（另行文档）

- 见 `docs/20260805-error-response-shape.md`（已定案选 A 彻底 problem+json，待开工）；改造时同步换 `ErrorResponse` 形状。

## 优先级与实施顺序

1. ~~**错误链 `%w`**~~：✅ 已实现（`273041f`）。
2. ~~**禁止 map/any jsonify**~~：✅ 已实现（`responses.go` typed struct，见 §2「现状」；错误响应 RFC 9457 改造随 `docs/20260805-error-response-shape.md` 进行）。
3. ~~**状态码常量**（§4）~~：✅ 已实现（`5c1c3b1`，37 处字面量 → `net/http` 常量）。
4. ~~**handler 错误样板收敛**（§5）~~：✅ 已实现（`59b12ae`，`writeLogOrError` helper 收敛 8 处）。
5. ~~**`go test -race`**~~（§6）：✅ 已实现（scripts + CI + README 命令加 `-race`）。
6. ~~**`log/slog`**~~（§3）：✅ 已实现（Go `ecbc9c0` + Node pino `7dfb1a3`，规范见 AGENTS.md「日志」）。
7. ~~**golangci-lint**~~（§7）：✅ 已实现（`.golangci.yml` + CI job；ST1005/ST1012 先清零，S1017×2/S1016×1 修复）。
8. **RFC 9457 错误响应**（§8 / error-response-shape.md）：独立破坏性改造，待决策后开工。

## 相关记录

- 架构定案：`docs/20260805-repository-architecture.md`。
- 错误响应结构化：`docs/20260805-error-response-shape.md`。
