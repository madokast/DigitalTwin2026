// Package recordrepo 提供唯一聚合根 Record 的持久化（领域语义方法，内部写 SQL）。
//
// 硬约束：本包禁止开事务。Repository 方法只消费构造注入的 Executor——业务层 UoW
// 传入的 tx（事务内）或非事务 pool（直连），绝不调用 Begin/Commit/Rollback。
// 事务边界是业务层 UoW 的职责（db.WithTx）；业务层需要多方法同事务时，在 uow.Do
// 闭包内用同一个 q（= tx）依次调用本包方法，原子性由业务层这一个事务保证。
package recordrepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// RecordRepository 唯一聚合根的持久化：领域语义方法，内部写 SQL。
// 无状态；构造注入 Executor（非事务 pool 或事务 tx 调用形态一致）。
type RecordRepository struct {
	q db.Executor
}

func New(q db.Executor) *RecordRepository {
	return &RecordRepository{q: q}
}

type RecordFindByIDResult struct {
	OK     bool
	Record record.Record
	Error  error // 领域哨兵；nil = 成功
}

// FindByID 按 id 查完整行：Scan → DBRow → FromDB（唯一转换点）→ 领域 Record；未找到 → record.ErrNotFound。
func (r *RecordRepository) FindByID(ctx context.Context, id string) RecordFindByIDResult {
	var row record.DBRow
	err := r.q.QueryRow(ctx, `
SELECT id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
FROM records WHERE id = $1
`, id).Scan(
		&row.ID, &row.HappenedAt, &row.UtcOffset, &row.NumericValue,
		&row.RawContent, &row.ObjectiveContext, &row.AiAnalysis, &row.Tags,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordFindByIDResult{Error: fmt.Errorf("record %s not found: %w", id, record.ErrNotFound)}
	}
	if err != nil {
		return RecordFindByIDResult{Error: err}
	}
	return RecordFindByIDResult{OK: true, Record: record.FromDB(row)}
}

type RecordSaveAllResult struct {
	OK      bool
	Records []record.Record
	Error   error
}

type RecordTransitionResult struct {
	OK    bool
	Error error
}

// Transition 只 UPDATE tags（WHERE id）；RowsAffected != 1 → 错误（D7：并发竞态文案含实际行数）。
// 领域规则（四态/审计/组装）在业务层；审计行由业务层调 Save 插入。
func (r *RecordRepository) Transition(ctx context.Context, id string, tags []string) RecordTransitionResult {
	tagsJSON, err := record.TagsJSON(tags)
	if err != nil {
		return RecordTransitionResult{Error: err}
	}
	ct, err := r.q.Exec(ctx, `UPDATE records SET tags = $1 WHERE id = $2`, tagsJSON, id)
	if err != nil {
		return RecordTransitionResult{Error: err}
	}
	if ct.RowsAffected() != 1 {
		return RecordTransitionResult{Error: fmt.Errorf("todo update affected %d rows", ct.RowsAffected())}
	}
	return RecordTransitionResult{OK: true}
}

type RecordSaveResult struct {
	OK     bool
	Record record.Record
	Error  error
}

// Save 单条 INSERT + RETURNING 完整行。nr 为写入意图（HappenedAt 已由业务层 NormalizeHappenedAt
// 解析为 DateTimeWithOffset，此处直接落 time.Time + utc_offset，不再解析）；
// 返回规范化领域 Record（FromDB）——业务层唯一使用的 happened_at 来源。
func (r *RecordRepository) Save(ctx context.Context, nr record.NewRecord) RecordSaveResult {
	tagsJSON, err := record.TagsJSON(nr.Tags)
	if err != nil {
		return RecordSaveResult{Error: err}
	}
	var out record.DBRow
	err = r.q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
`, nr.ID, nr.HappenedAt.Time, nr.HappenedAt.Offset, nr.NumericValue, nr.RawContent, nr.ObjectiveContext, nr.AiAnalysis, tagsJSON).Scan(
		&out.ID, &out.HappenedAt, &out.UtcOffset, &out.NumericValue,
		&out.RawContent, &out.ObjectiveContext, &out.AiAnalysis, &out.Tags,
	)
	if err != nil {
		return RecordSaveResult{Error: err}
	}
	return RecordSaveResult{OK: true, Record: record.FromDB(out)}
}

// SaveAll 批量 INSERT（循环复用 Save 单条原语，行为与顺序确定）；事务内调用。
//
// TODO(perf)：当前是逐条 INSERT（N 次往返）。批量场景可优化为单条多值 INSERT
// （`INSERT ... VALUES (...),(...) ... RETURNING`）——但 PG 的 RETURNING 不保证与
// VALUES 顺序一致，需额外按 id ORDER BY（或临时表）恢复输入顺序。本项目 batch 量小暂未做。
func (r *RecordRepository) SaveAll(ctx context.Context, nrs []record.NewRecord) RecordSaveAllResult {
	out := make([]record.Record, 0, len(nrs))
	for _, nr := range nrs {
		res := r.Save(ctx, nr)
		if !res.OK {
			return RecordSaveAllResult{Error: res.Error}
		}
		out = append(out, res.Record)
	}
	return RecordSaveAllResult{OK: true, Records: out}
}
