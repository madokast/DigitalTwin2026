# UoW + Repository 端到端代码参考

> 创建日期：2026-08-05
> 性质：**目标形态参考**（迁移后代码）。以 `POST /api/log/numbers`（批量 create，事务）为主线，展示从请求到落库的完整代码风格，及涉及的每个接口与实际实现封装。供实施时对照（`docs/20260805-repository-architecture.md` + `review.md` 为定案依据）。

## 总览：一次事务的完整链路

```
HTTP 请求
  → router.ServeHTTP（自写路由，匹配分发）
  → httpx.Server.handleLogNumbers（handler：读 body → 调业务函数 → 组响应）
  → logapi.CreateNumberBatch（业务层：校验零 DB → WithTx 闭包 → Repository 领域方法）
  → recordrepo.RecordRepository.SaveAll（领域持久化，内部 SQL）
  → db.Executor / pgx 驱动 → 事务 Commit / Rollback
```

---

# Go 端

## 1. 接口定义（`faas/internal/db/interfaces.go`）

```go
package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Executor：可执行 SQL 的句柄（读路径 / 事务内操作）。仅 Repository 内部使用。
// *pgxpool.Pool 与 pgx.Tx 均满足；单测可假实现。
type Executor interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Tx：事务句柄 = Executor + 提交/回滚。pgx.Tx 满足。
type Tx interface {
	Executor
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// TxBeginner：能开事务的入口（写路径）。*pgxpool.Pool 满足。
type TxBeginner interface {
	Executor
	Begin(ctx context.Context) (Tx, error)
}

// WithTx：闭包式 UoW——Begin → fn(tx) → 成功 Commit / 失败 Rollback。
// 业务方零事务 API：不手动 Begin/Commit/Rollback，闭包返回 nil 即提交。
func WithTx(ctx context.Context, q TxBeginner, fn func(q Executor) error) error {
	tx, err := q.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
```

## 2. 实际实现封装（无需适配器，天然满足）

```go
// faas/internal/db/db.go（现状，仅示意签名）
// db.Open 读 DATABASE_URL 创建连接池，返回 *pgxpool.Pool。
func Open(ctx context.Context) (*pgxpool.Pool, error) { ... }
```

**满足关系**（全部天然，零适配器）：

| 接口 | 满足者 | 说明 |
|---|---|---|
| `Executor` | `*pgxpool.Pool`、`pgx.Tx` | 均有 `QueryRow/Exec/Query` |
| `Tx` | `pgx.Tx` | 有 `Commit/Rollback` |
| `TxBeginner` | `*pgxpool.Pool` | 有 `Begin(ctx) (pgx.Tx, error)` |

> 现有 `poolAdapter`（todo.go）、`transitionDB`/`transitionTx` 在迁移后删除——统一被三层接口取代。

## 3. Repository（`faas/internal/recordrepo/repository.go`）

```go
package recordrepo

import (
	"context"
	"fmt"

	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// RecordRepository 唯一聚合根的持久化：领域语义方法，内部写 SQL。
// 无状态；方法第一参数一律收 Executor（事务内外同一签名，事务边界在业务层 WithTx）。
type RecordRepository struct{}

// SaveAll 批量插入（UoW 内）。返回插入后的完整行（含 id）。
func (r *RecordRepository) SaveAll(ctx context.Context, q db.Executor, records []record.Record) ([]record.Record, error) {
	out := make([]record.Record, 0, len(records))
	for _, rec := range records {
		// SQL 只出现在 Repository 内部
		var (
			outID, outTags, outObj, outOffset string
			outHappened                       time.Time
			outNum, outText, outSubj          *string
		)
		err := q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
`, rec.ID, rec.HappenedAt, rec.UtcOffset, rec.NumericValue, rec.RawContent,
			rec.ObjectiveContext, rec.AiAnalysis, rec.TagsJSON).Scan(
			&outID, &outHappened, &outOffset, &outNum, &outText, &outObj, &outSubj, &outTags,
		)
		if err != nil {
			return nil, fmt.Errorf("insert record: %w", err)
		}
		out = append(out, record.FromDB(outID, outHappened, outOffset, outNum, outText, outTags, outObj, outSubj))
	}
	return out, nil
}
```

## 4. 业务层（`faas/internal/logapi/number.go` 迁移后）

### 4a. 领域错误映射（含事务内错误分类的写法）

**DDD Error（一套，双端对称；message 可固定或运行时拼接）**：

```go
// faas/internal/record/errors.go —— 领域错误哨兵（Go）
var (
	ErrNotFound = errors.New("record not found")                              // 固定 message
	ErrConflict = errors.New("record tags changed concurrently, retry")       // 固定 message
)

// ErrInternal：内部错误（三方库错误防腐层吸收后的领域错误）
// 存原始 err + Unwrap 保链：Error() 返回原文，errors.As 命中 InternalError，底层链仍可 errors.Is 穿透
type InternalError struct{ err error }
func (e *InternalError) Error() string { return e.err.Error() }
func (e *InternalError) Unwrap() error { return e.err }
func ErrInternal(err error) error {
	if err == nil {
		return nil
	}
	return &InternalError{err: err}
}

// 运行时拼接：fmt.Errorf("record %s not found: %w", id, record.ErrNotFound)
```
```ts
// src/lib/record/errors.ts —— 领域错误类（Node）
export class RecordNotFoundError extends Error {}
export class RecordConflictError extends Error {}
export class InternalError extends Error {} // 随 Repository 一起引入（阶段 B）；不 throw，放 res.error
// 运行时拼接：new RecordNotFoundError(`record ${id} not found`)
```

**每方法专属 XXXXResult（拒绝泛型，Go/Node 同名同构；error 字段是领域错误对象，null/nil = 成功）**：

```go
type RecordFindByIDResult struct {
	OK     bool
	Record record.Record
	Error  error // 领域哨兵；nil = 成功
}
```
```ts
export type RecordFindByIDResult = {
	ok: boolean
	record: Record | null
	error: Error | null // 领域错误实例；null = 成功（Node 不 throw，错误放 Result）
}
```

```go
// Repository 返回 Result（recordrepo/repository.go）
func (r *RecordRepository) FindByID(ctx context.Context, q db.Executor, id string) RecordFindByIDResult {
	var res RecordFindByIDResult
	err := q.QueryRow(...).Scan(...)
	if errors.Is(err, pgx.ErrNoRows) {
		res.Error = fmt.Errorf("record %s not found: %w", id, record.ErrNotFound)
		return res
	}
	if err != nil {
		res.Error = record.ErrInternal(err) // 三方库错误 → 领域错误（防腐层吸收，阶段 B）
		return res
	}
	res.OK, res.Record = true, rec
	return res
}
```

```ts
// Node（src/lib/recordrepo.ts）
async findById(q: Executor, id: string): Promise<RecordFindByIDResult> {
	...
	if (rows.length === 0) {
		return { ok: false, record: null, error: new RecordNotFoundError(`record ${id} not found`) }
	}
	return { ok: true, record: fromDB(rows[0]), error: null }
}
```

```go
// 业务函数签名保持 (T, status, error)；status 在闭包外 errors.Is / instanceof 映射。
// 错误处理风格：先 err==nil 快速返回成功；switch 全用 errors.Is；
// default = 未知错误 = 漏了 case 需补代码（暂 500 并留注释）。
func AttachTag(ctx context.Context, q db.TxBeginner, id, tag string) (TagsEdit, int, error) {
	var result TagsEdit
	err := db.WithTx(ctx, q, func(q db.Executor) error {
		res := recordRepo.FindByID(ctx, q, id)
		if !res.OK {
			return res.Error // 领域错误透传
		}
		res2 := recordRepo.AttachTag(ctx, q, res.Record, tag)
		if !res2.OK {
			return res2.Error
		}
		result = toTagsEdit(res.Record, res2.Record)
		return nil
	})
	if err == nil {
		return result, http.StatusOK, nil // 成功路径快速返回
	}
	switch {
	case errors.Is(err, record.ErrNotFound):
		return result, http.StatusNotFound, err
	case errors.Is(err, record.ErrConflict):
		return result, http.StatusConflict, err
	default:
		// 未知错误：漏了 case，需要补代码
		return result, http.StatusInternalServerError, err
	}
}
```

```ts
// Node Service（src/lib/recordrepo.ts 或 logapi.ts）
const res = await recordRepo.findById(q, id)
if (!res.ok) {
	if (res.error instanceof RecordNotFoundError) return { error: res.error.message, status: 404 }
	if (res.error instanceof RecordConflictError) return { error: res.error.message, status: 409 }
	return { error: 'Internal server error', status: 500 }
}
```

> 400 校验错误发生在事务外（零 DB），业务函数直接 `return ..., 400, err`，无需领域分类。

```go
package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

var recordRepo = &recordrepo.RecordRepository{}

// numberRecords 业务层组装领域对象（id 生成 + tagsJSON 编码 + 字段映射），零 DB。
func numberRecords(batch *numberdraft.NumberBatch) ([]record.Record, error) {
	out := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		id, err := uuid.NewV7()
		if err != nil {
			return nil, err
		}
		tagsJSON, err := record.TagsJSON(e.Tags)
		if err != nil {
			return nil, err
		}
		out = append(out, record.NewNumber(
			id.String(), batch.HappenedAt, batch.UtcOffset,
			&e.NumericValue, tagsJSON, e.ObjectiveContext, e.AiAnalysis,
		))
	}
	return out, nil
}

// CreateNumberBatch 校验（零 DB）→ WithTx 闭包 → Repository 领域方法。
// q 收 TxBeginner（业务层传 pool，天然满足；单测传 fake）。
func CreateNumberBatch(ctx context.Context, q db.TxBeginner, raw []byte) (int, []record.Record, int, error) {
	batch, err := numberdraft.ParseNumberBatch(raw)
	if err != nil {
		return 0, nil, 400, err
	}
	records, err := numberRecords(batch)
	if err != nil {
		return 0, nil, 500, err
	}

	var (
		inserted int
		out      []record.Record
	)
	err = db.WithTx(ctx, q, func(q db.Executor) error {
		recs, err := recordRepo.SaveAll(ctx, q, records) // 领域语言，无 SQL
		if err != nil {
			return err
		}
		inserted, out = len(recs), recs
		return nil
	})
	if err != nil {
		return 0, nil, 500, err
	}
	return inserted, out, 201, nil
}
```

## 5. handler（`faas/internal/httpx/server.go`）

```go
type Server struct {
	Pool db.TxBeginner // ← 由 *pgxpool.Pool 放宽为接口；NewServer 仍收 *pgxpool.Pool（自动满足）
	...
}

func (s *Server) handleLogNumbers(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyOrError(w, r)
	if !ok {
		return
	}
	inserted, recs, status, err := logapi.CreateNumberBatch(r.Context(), s.Pool, raw)
	if err != nil {
		// 阶段 B 定案形态：日志与错误写出拆开（writeLogOrError 已删除）
		logResponseError(status, "Error creating number records", err) // 仅 status>=500 记日志
		writeError(w, status, errorDetail(err))                        // detail 透传；空 message 以 %T 兜底
		return
	}
	go s.notify().NotifyNumberBatchInserted(recs)
	writeJSON(w, status, NumberBatchSuccess{Success: true, Inserted: inserted, Atomic: true})
}
```

## 6. 装配（`faas/cmd/api/main.go`，基本不变）

```go
pool, err := db.Open(ctx)              // *pgxpool.Pool
srv := httpx.NewServer(pool, auth.TokensFromEnv())  // 赋给 db.TxBeginner 字段（自动满足）
```

## 7. 单测 fake + 回滚测试（`faas/internal/logapi/number_rollback_test.go`）

```go
package logapi

// fakeTx：可控事务。Exec 在第 failOn 次调用返回注入错误 → 触发回滚。
type fakeTx struct {
	execCount int
	failOn    int
	committed bool
}

func (f *fakeTx) Exec(_ context.Context, _ string, _ ...any) (pgconn.CommandTag, error) {
	f.execCount++
	if f.execCount == f.failOn {
		return pgconn.CommandTag{}, errors.New("injected failure")
	}
	return pgconn.CommandTag{}, nil
}
func (f *fakeTx) QueryRow(...) pgx.Row { panic("not used") }
func (f *fakeTx) Query(...) (pgx.Rows, error) { return nil, nil }
func (f *fakeTx) Commit(_ context.Context) error { f.committed = true; return nil }
func (f *fakeTx) Rollback(_ context.Context) error { return nil }

// fakeBeginner：能开事务的入口。
type fakeBeginner struct{ tx *fakeTx }

func (b *fakeBeginner) Begin(_ context.Context) (db.Tx, error) { return b.tx, nil }
func (b *fakeBeginner) QueryRow(...) pgx.Row { panic("not used") }
func (b *fakeBeginner) Exec(...) (pgconn.CommandTag, error) { panic("not used") }
func (b *fakeBeginner) Query(...) (pgx.Rows, error) { panic("not used") }

// TestCreateNumberBatchRollback：第 2 条 INSERT 失败 → 全部回滚 → 不 Commit → 500。
func TestCreateNumberBatchRollback(t *testing.T) {
	tx := &fakeTx{failOn: 2}
	q := &fakeBeginner{tx: tx}
	_, _, status, err := CreateNumberBatch(context.Background(), q, []byte(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"entries":[{...},{...}]
	}`))
	if err == nil || status != 500 {
		t.Fatalf("want 500 got status=%d err=%v", status, err)
	}
	if tx.committed {
		t.Fatal("must not commit after injected failure")
	}
}
```

---

# Node 端

## 1. 执行器类型 + withTx（`src/lib/recordrepo.ts`）

```ts
import db from '@/db'
import { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core'

/** Executor：可执行器形状（drizzle db 与事务 tx 的公共方法集）。
 *  与 Go `Executor` 同名对齐（AGENTS.md 双端同构）；Node 无 Tx/TxBeginner 对应类型——
 *  drizzle `db.transaction` 已封装事务边界（Commit/Rollback 由框架管），业务方只见到 Executor。 */
export type Executor = Pick<
  PgDatabase<Record<string, never>>,
  'insert' | 'select' | 'update' | 'delete' | 'execute'
>

/** withTx：闭包式 UoW，包装 drizzle db.transaction；与 Go WithTx 同构（业务方零事务 API） */
export function withTx<T>(fn: (q: Executor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as Executor))
}

/** RecordRepository：唯一聚合根持久化（领域语义，内部 SQL） */
export const recordRepo = {
  async saveAll(q: Executor, records: RecordInput[]): Promise<Record[]> {
    const rows = await q.insert(schema.records).values(records).returning()
    return rows.map(fromDB)
  },
}
```

## 2. 业务层（`src/lib/logapi.ts` 迁移后）

```ts
export async function createNumberBatch(
  body: unknown,
): Promise<NumberBatchResult | LogApiError> {
  const batch = parseNumberBatch(body)
  if ('error' in batch) return batch
  const records = batch.entries.map((e) => newNumberRecord(batch, e)) // 组装领域对象，零 DB

  try {
    const inserted = await withTx(async (tx) => {
      const recs = await recordRepo.saveAll(tx, records) // 领域语言，无 SQL
      return recs
    })
    return { inserted: inserted.length, records: inserted, status: 201 }
  } catch (err) {
    logger.error({ err }, 'Error creating number records')
    return { error: 'Internal server error', status: 500 }
  }
}
```

## 3. route（`src/app/api/log/numbers/route.ts`，调用链不变）

```ts
const result = await createNumberBatch(parsed.value)
if ('error' in result) {
  return errorResponse(result.error, result.status)
}
scheduleBestEffortNotify(() => notifyNumberBatchInserted(result.records))
return NextResponse.json({ success: true, inserted: result.inserted, atomic: true }, { status: result.status })
```

## 4. 单测（`vi.mock('@/db')` mock 模块）

```ts
vi.mock('@/db', () => ({
  __esModule: true,
  default: {
    transaction: vi.fn(async (fn: unknown) => {
      // 可注入：让 tx 的第 N 次 insert 抛错，验证回滚（断言 insert 调用 + 不落库）
      const fakeTx = { insert: vi.fn().mockRejectedValue(new Error('injected')) }
      return (fn as (q: unknown) => Promise<unknown>)(fakeTx)
    }),
  },
}))

it('rolls back when the Nth insert fails', async () => {
  const res = await createNumberBatch({ happened_at: '...', entries: [...] })
  expect(res.status).toBe(500)
})
```

---

## 双端形态对照

| 环节 | Go | Node |
|---|---|---|
| 执行器类型名 | `Executor`（+ `Tx` / `TxBeginner`） | `Executor`（**无 Tx/TxBeginner**——drizzle transaction 已封装事务边界） |
| 事务闭包 | `db.WithTx(ctx, q TxBeginner, fn(q Executor))` | `withTx(fn(q: Executor))`（包装 `db.transaction`） |
| 业务层 | 校验零 DB → `WithTx` 闭包 → `recordRepo.SaveAll(q, ...)` | 同左 |
| Repository | `SaveAll(ctx, q, records)`（内部 SQL） | `recordRepo.saveAll(q, records)` |
| 执行器来源 | 业务函数收参数（`pool`，接口注入） | 全局 `db` 单例（`vi.mock` 模块） |
| 测试机制 | fake `TxBeginner`/`Tx` | `vi.mock('@/db')` |

**形态同构（业务代码一样长闭包，类型名/参数名统一 `Executor`/`q`）、注入机制不同（Go 接口 / Node 模块 mock）**——后者是框架差异，非不一致。
