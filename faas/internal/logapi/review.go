package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
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

	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record。
	res := recordrepo.Repo.Save(ctx, pool, record.NewRecord{
		ID: id.String(),
		HappenedAt: draft.DateTimeWithOffset{
			Time:   parsed.HappenedAt,
			Offset: parsed.UtcOffset,
		},
		NumericValue:     nil,
		RawContent:       &parsed.RawContent,
		Tags:             tagList,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       aiAnalysisPtr(parsed.AiAnalysis),
	})
	if !res.OK {
		return record.Record{}, 500, err
	}
	return res.Record, 201, nil
}
