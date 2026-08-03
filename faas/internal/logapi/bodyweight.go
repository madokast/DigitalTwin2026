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

	tagsJSON, err := record.TagsJSON(parsed.Tags)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	vn := parsed.ValueNumber
	rec, err := insertReturning(
		ctx, pool, id.String(), parsed.HappenedAt, parsed.UtcOffset, &vn, nil,
		tagsJSON, parsed.ObjectiveContext, parsed.SubjectiveInterpretation,
	)
	if err != nil {
		return record.Record{}, 500, fmt.Errorf("insert body weight: %w", err)
	}
	return rec, 201, nil
}
