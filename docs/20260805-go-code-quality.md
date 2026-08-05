# Go 代码质量规范（错误链 / JSON 组装 / 日志）

> 创建日期：2026-08-05
> 性质：Go 侧代码质量规范与待办清单。三项互相关联的 Go 惯例问题：错误链 `%w`、禁止 map/any jsonify、结构化日志 slog。
> 触发：UoW + Repository 架构审查（`docs/20260805-repository-architecture.md`）时发现 Go 侧多处不符合业界惯例；其中「禁止 map/any jsonify」为**永久规范**（key 顺序问题，AI 读响应字符串会很奇怪）。

## 1. Go 错误链 `%w`（首要，先改）

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

- **Go 错误消息 = API 契约文案**：`writeError(w, status, err.Error())` 直接输出 Go error 为 HTTP `error` 字段，Node 端逐字一致（如 `Missing required query parameter: from` 大写开头）。全仓 44 处大写开头错误字面量均为契约。
- 因此 Go 惯例「错误小写开头」（ST1005）在本仓库 **不适用**——契约优先，双端一致是硬约束。
- `%w` 改造 **只改机制**：`%s`→`%w`、string 常量→`errors.New`（**同文案**）——**文案字符串逐字不动**。
- **禁止顺手改大小写 / 标点 / 措辞**——即使看起来「更符合 Go 惯例」；任何文案改动都会破坏 Node 一致性并被双端契约测试拦截。
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

### 现状（待改）

- `faas/internal/httpx/server.go` 等：**15+ 处** `writeJSON(w, status, map[string]any{...})` 内联组装（如 `{"success": true, "record": rec}`、`{"success": true, "inserted": n, "type": t, "sum": s, "atomic": true}`）。
- `writeError`：`map[string]string{"error": msg}`（见 `docs/20260805-error-response-shape.md` 一并处理）。

### 改法

为每个响应形状定义 typed struct（如 `CreateBatchResponse{Success bool `json:"success"`; Inserted int `json:"inserted"`; ...}`），或复用已有 struct；`writeJSON` 仍收 `any`，但调用处只传 typed 值。

### 优先级

- 低优先（可后置），但与 `docs/20260805-error-response-shape.md`（错误响应结构化）合并实施——错误响应本身就是 `map[string]string{"error"}`，一起改 typed。

## 3. 结构化日志 `log/slog`（低优先，可后置）

### 现状

- 全仓 `log.Printf`（标准库 log）。Go 1.21+ 业界推荐 `log/slog`（结构化键值对、可接采集）。

### 目标

- 服务启动 / handler 错误日志改 `slog`：`slog.Error("create transaction failed", "err", err, "path", r.URL.Path)`。
- 保持**用户可见文案英文**（AGENTS.md 语言原则）；日志属 stdout/stderr，用英文。

### 优先级

- 低优先，独立小改造；不阻塞错误链与 JSON 组装。

## 优先级与实施顺序

1. **错误链 `%w`**（首要，先改）：48 处 `%s` → 哨兵 + `%w`；纯内部，测试全绿即完成。
2. **禁止 map/any jsonify**：15+ 处 handler 响应改 typed struct（与错误响应结构化合并）。
3. **`log/slog`**：低优先后置。

## 相关记录

- 架构定案：`docs/20260805-repository-architecture.md`。
- 错误响应结构化：`docs/20260805-error-response-shape.md`。
