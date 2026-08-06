package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/bodyweightdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

// CreateBodyWeight 与 Next createBodyWeight 对齐：落库强制含 body:weight。
// 收 typed 产物（route 层经 bodyweightdraft.ParseBodyWeight 解析校验）。
func CreateBodyWeight(ctx context.Context, pool *pgxpool.Pool, parsed bodyweightdraft.NormalizedBodyWeight) (record.Record, *myerr.MyError) {
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	vn := parsed.NumericValue
	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record。
	rec, me := recordrepo.Repo.Save(ctx, pool, record.Record{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     &vn,
		RawContent:       nil,
		Tags:             parsed.Tags,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       parsed.AiAnalysis,
	})
	if me != nil {
		return record.Record{}, me
	}
	return rec, nil
}
