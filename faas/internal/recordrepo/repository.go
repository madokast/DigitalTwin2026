package recordrepo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
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

// FindByID 按 id 查完整行（持久化转换：瞬间 + 隐列 → 带区串，在 record.FromDB 收敛）；未找到 → record.ErrNotFound。
func (r *RecordRepository) FindByID(ctx context.Context, id string) RecordFindByIDResult {
	var (
		outID, outTags, outObj, outOffset string
		outHappened                       time.Time
		outNum, outText, outSubj          *string
	)
	err := r.q.QueryRow(ctx, `
SELECT id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
FROM records WHERE id = $1
`, id).Scan(
		&outID, &outHappened, &outOffset, &outNum, &outText, &outObj, &outSubj, &outTags,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordFindByIDResult{Error: fmt.Errorf("record %s not found: %w", id, record.ErrNotFound)}
	}
	if err != nil {
		return RecordFindByIDResult{Error: err}
	}
	return RecordFindByIDResult{
		OK:     true,
		Record: record.FromDB(outID, outHappened, outOffset, outNum, outText, outTags, outObj, outSubj),
	}
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

// Save 单条 INSERT + RETURNING 完整行。rec.HappenedAt 为带区 ISO（领域对象 = 对外形状），
// 持久化转换（带区串 → 瞬间 + 隐列）在此内部完成（draft.ParseHappenedAt）。
func (r *RecordRepository) Save(ctx context.Context, rec record.Record) RecordSaveResult {
	happenedAt, utcOffset, err := draft.ParseHappenedAt(rec.HappenedAt)
	if err != nil {
		return RecordSaveResult{Error: err}
	}
	tagsJSON, err := record.TagsJSON(rec.Tags)
	if err != nil {
		return RecordSaveResult{Error: err}
	}
	var (
		outID, outTags, outObj, outOffset string
		outHappened                       time.Time
		outNum, outText, outSubj          *string
	)
	err = r.q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
`, rec.ID, happenedAt, utcOffset, rec.NumericValue, rec.RawContent, rec.ObjectiveContext, rec.AiAnalysis, tagsJSON).Scan(
		&outID, &outHappened, &outOffset, &outNum, &outText, &outObj, &outSubj, &outTags,
	)
	if err != nil {
		return RecordSaveResult{Error: err}
	}
	return RecordSaveResult{
		OK:     true,
		Record: record.FromDB(outID, outHappened, outOffset, outNum, outText, outTags, outObj, outSubj),
	}
}
