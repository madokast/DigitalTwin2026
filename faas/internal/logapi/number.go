package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// CreateNumberBatch 整单事务写入；成功返回 inserted 与行（供通知）。
// Body 顶层 happened_at 共享；entry numeric_value/memo 必填、tags/ai_analysis 可选。
// 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
func CreateNumberBatch(ctx context.Context, pool *pgxpool.Pool, raw []byte) (int, []record.Record, int, error) {
	batch, err := numberdraft.ParseNumberBatch(raw)
	if err != nil {
		return 0, nil, 400, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, nil, 500, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		tagsJSON, err := record.TagsJSON(e.Tags)
		if err != nil {
			return 0, nil, 500, err
		}
		id, err := uuid.NewV7()
		if err != nil {
			return 0, nil, 500, err
		}
		rec, err := insertReturning(ctx, tx, record.DBRow{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAt,
			UtcOffset:        batch.UtcOffset,
			NumericValue:     &e.NumericValue,
			RawContent:       nil,
			Tags:             tagsJSON,
			ObjectiveContext: e.ObjectiveContext,
			AiAnalysis:       e.AiAnalysis,
		})
		if err != nil {
			return 0, nil, 500, err
		}
		out = append(out, rec)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, 500, err
	}
	return len(out), out, 201, nil
}
