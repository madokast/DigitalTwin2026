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

// Save 单条 INSERT + RETURNING 完整行。row 为 DB 直接映射（time.Time + utc_offset + tags JSON 字符串），
// SQL 直接消费，零时间字符串转换；返回领域 Record（FromDB）。
func (r *RecordRepository) Save(ctx context.Context, row record.DBRow) RecordSaveResult {
	var out record.DBRow
	err := r.q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
`, row.ID, row.HappenedAt, row.UtcOffset, row.NumericValue, row.RawContent, row.ObjectiveContext, row.AiAnalysis, row.Tags).Scan(
		&out.ID, &out.HappenedAt, &out.UtcOffset, &out.NumericValue,
		&out.RawContent, &out.ObjectiveContext, &out.AiAnalysis, &out.Tags,
	)
	if err != nil {
		return RecordSaveResult{Error: err}
	}
	return RecordSaveResult{OK: true, Record: record.FromDB(out)}
}
