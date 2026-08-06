package logapi

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/bodyweightdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// CreateBodyWeight 与 Next createBodyWeight 对齐：解析委托 bodyweightdraft，落库强制含 body:weight。
func CreateBodyWeight(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	parsed, err := bodyweightdraft.ParseBodyWeight(raw)
	if err != nil {
		return record.Record{}, 400, err
	}

	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	vn := parsed.NumericValue
	rec, err := insertReturning(ctx, pool, record.Record{
		ID:               id.String(),
		HappenedAt:       formatHappenedAt(parsed.HappenedAt, parsed.UtcOffset),
		NumericValue:     &vn,
		RawContent:       nil,
		Tags:             parsed.Tags,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       aiAnalysisPtr(parsed.AiAnalysis),
	})
	if err != nil {
		return record.Record{}, 500, fmt.Errorf("insert body weight: %w", err)
	}
	return rec, 201, nil
}
