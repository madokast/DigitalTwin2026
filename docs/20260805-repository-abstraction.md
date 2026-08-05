# 仓储层抽象：业务层 DB 依赖现状与方案

> 创建日期：2026-08-05
> 性质：架构讨论/定案文档。业务层不应直接依赖第三方 DB 类型（应包装为仓储/接口），
> 由此引出可测性、解耦与事务边界。触发：`log/numbers` 批量验收第 5 项（事务原子性）时，
> 发现无法 mock DB 测试「中间插入失败 → 回滚」，根因是业务层直接耦合 `*pgxpool.Pool`。

## 现状分析

### Go 侧

- `faas/internal/db/querier.go` 已定义 `db.Querier` 接口（`Query` / `Exec` / `QueryRow`），
  `*pgxpool.Pool` 天然满足；**但只有 `tags` 包使用了它**（为 `renameAcrossQuerier` 单测）。
- 其余业务层（`logapi` / `query` / `exportapi` / `importapi` / `httpx`）函数签名直接是
  **`*pgxpool.Pool`**（第三方 pgx 具体类型）。

### Node 侧

- `src/lib/logapi.ts` / `tagsdb.ts` / `exportapi.ts` / `query.ts` / `importapi.ts` 直接
  `import db from '@/db'`（drizzle + postgres-js 实例）。
- Node 无「依赖注入」习惯——`db` 是模块级单例，业务函数内部直接调 `db.select/insert`。
- Node 测试依赖 **mock 模块**（`vi.mock('@/db')`）而非接口替换。

### 后果

1. **耦合**：业务层绑定第三方 DB 类型，换 DB / 换驱动需改业务层。
2. **不可测**：
   - Go：具体类型无法注入 fake → 「事务失败回滚」「SQL 断言」测不了
     （`log/numbers` 验收时暴露：无法验证「中间一条插入失败 → 全部回滚」）。
   - Node：可 mock 模块，但 mock 的是 drizzle 全对象，粒度粗、脆弱。
3. **事务边界**：`db.Querier` 无 `Begin`，批量事务无法通过接口测试。

## 目标

业务层（draft / logapi / query / export / import）不应直接使用第三方 DB 类型，而是
通过**仓储接口**访问；接口注入使单测可假实现、可断言。

## 方案

### 方案 A：最小（仅解 `log/numbers` 验收卡点）

为 `CreateNumberBatch` 引入含 `Begin` 的事务接口，fake 实现验证回滚：

```go
// db.Querier 增加 Begin（或单独 TxBeginner 接口）
type TxBeginner interface {
    Begin(ctx context.Context) (pgx.Tx, error)
}
```

- 治标：只解 number 的事务测试；其余业务层仍耦合。
- fake 需实现 `pgx.Tx`（方法多，可 panic 大部分）。

### 方案 B：系统性（Go 推广 `db.Querier` / `TxBeginner`）

- 业务层签名 `*pgxpool.Pool` → `db.Querier`（无事务操作）/ `db.TxBeginner`（需 Begin）。
- 全部 logapi / query / export / import 改造 + fake 单测覆盖事务与 SQL 断言。
- 成本大（十几个文件 + 全套 fake），但治本（解耦 + 可测）。
- Node 侧对应：业务层接受「执行器接口」，测试注入 fake executor
  （而非 mock 整个 drizzle db 模块）。

### 方案 C：Node 单独轻量化

- Node 侧保持 `@/db` 单例，但**业务层导出「执行器类型」**，测试用 `vi.mock('@/db')`
  只 mock 用到的 `db.transaction` / `db.insert`，粒度收窄。
- 不引入接口注入，只改进 mock 策略，成本最低。

## 待决策

1. ~~**范围**~~：✅ **方案 B（系统性，深度对齐）**——Go 推广 `db.Querier`/`TxBeginner` 替换业务层 `*pgxpool.Pool`；Node 对齐做执行器注入（非 mock 整个 db 模块）。
2. ~~**Node 侧深度**~~：✅ 与 Go 对齐，业务层接受「执行器接口」，测试注入 fake executor。
3. **事务接口**：`Begin` 放 `db.Querier` 还是独立 `TxBeginner`？返回 `pgx.Tx` 是否可接受？——实现时定。
4. **优先级**：**log/numbers 中途失败回滚测试是当前验收阻塞项**——先补，随方案 B 一起落地。

## 实施顺序（定案）

1. Go：定义事务化仓储接口（`db.TxBeginner` 或含 Begin 的 Querier），改造 logapi（number/text/todo/body/weight/review/transaction）签名 `*pgxpool.Pool` → 接口。
2. Go：fake 实现 → 补 `log/numbers` 中途插入失败回滚测试（第 N 次 insert 注入错误，断言全部回滚、返回 500）。
3. Node：业务层「执行器接口」注入（logapi 等），测试注入 fake executor（或收窄 `vi.mock('@/db')` 到 `db.transaction`）。
4. Node：补对应回滚测试。
5. 回归：全量 unit + integration + lint。

## 当前验收状态（log/numbers 第 5 项：事务原子性）

- ✅ **单事务实现**：`CreateNumberBatch` 用 `pool.Begin` + `defer tx.Rollback`（Go）、`db.transaction`（TS）——代码层面正确。
- ✅ **校验在事务外**：`ParseNumberBatch` 在 `Begin` 前执行（参数错误 → 400，不开启事务）。
- ❌ **回滚测试缺失**：业务层直接耦合 `*pgxpool.Pool`，无法注入 fake 验证「中间插入失败 → 全部回滚」。**待方案 B 落地时补**（见实施顺序第 2 步）。
- ⚠️ **曾尝试实现后回滚**：方案 B 的 Go 接口改造 + rollback 测试曾被实现（`db/querier.go` 加 `Tx`/`TxBeginner`/`TxBeginnerPool`、`CreateNumberBatch` 改签名、`number_rollback_test.go`），后因属大改动而回滚——**仅保留本文档**，代码回到未实现状态。

## 相关记录

- 现有 `db.Querier`：`faas/internal/db/querier.go`。
- 现有 fake 模式：`faas/internal/tags/tags_db_test.go`（`fakeQuerier` / `fakeRows`）。
- 验收上下文：`docs/20260805-log-number-batch.md` 实现注意点第 5 条（事务原子性）。
