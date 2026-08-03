package logapi

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// CreateTodo 与 Next createTodo 对齐：解析委托 tododraft，落库强制含 todo:in_progress。
// 返回内部 Record；HTTP 层再用 tododraft.ToTodoRecordJSON 变形响应。
func CreateTodo(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	parsed, err := tododraft.ParseTodo(raw)
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

	vt := parsed.ValueText
	rec, err := insertReturning(
		ctx, pool, id.String(), parsed.HappenedAt, nil, &vt,
		tagsJSON, parsed.ObjectiveContext, parsed.SubjectiveInterpretation,
	)
	if err != nil {
		return record.Record{}, 500, fmt.Errorf("insert todo: %w", err)
	}
	return rec, 201, nil
}
