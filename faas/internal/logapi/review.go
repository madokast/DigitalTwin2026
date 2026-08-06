package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/reviewdraft"
)

// CreateReview 校验复盘请求并落库；落库 tags = [review:{cadence}, ...clientTags]
//（自动附加，客户端不得传 review:*；解析已在 reviewdraft 内完成）。
func CreateReview(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	parsed, err := reviewdraft.ParseReview(raw)
	if err != nil {
		return record.Record{}, 400, err
	}

	tagList := reviewdraft.ReviewTagsForCadence(parsed.Cadence, parsed.Tags)

	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	rec, err := insertReturning(ctx, pool, record.RecordRow{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAt,
		UtcOffset:        parsed.UtcOffset,
		NumericValue:     nil,
		RawContent:       &parsed.RawContent,
		Tags:             tagList,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       aiAnalysisPtr(parsed.AiAnalysis),
	})
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}
