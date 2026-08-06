package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/reviewdraft"
)

// CreateReview 校验复盘请求并落库；落库 tags = [review:{cadence}, ...clientTags]
// （自动附加，客户端不得传 review:*）。收 typed 产物（route 层经 reviewdraft.ParseReview 解析校验）。
func CreateReview(ctx context.Context, pool *pgxpool.Pool, parsed reviewdraft.NormalizedReview) (record.Record, *myerr.MyError) {
	tagList := reviewdraft.ReviewTagsForCadence(parsed.Cadence, parsed.Tags)
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record。
	rec, me := recordrepo.Repo.Save(ctx, pool, record.Record{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     nil,
		RawContent:       &parsed.RawContent,
		Tags:             tagList,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       parsed.AiAnalysis,
	})
	if me != nil {
		return record.Record{}, me
	}
	return rec, nil
}
