package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// CreateTransactionBatch 整单事务写入；成功返回 inserted 与行（供 Telegram 摘要）。
// Body 必填顶层 type（income|expense）；amount 为零 → 400。
func CreateTransactionBatch(ctx context.Context, pool *pgxpool.Pool, raw []byte) (int, []record.Record, int, error) {
	batch, err := transactiondraft.ParseTransactionBatch(raw)
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
		id, err := uuid.NewV7()
		if err != nil {
			return 0, nil, 500, err
		}
		tagsJSON, err := record.TagsJSON(e.Tags)
		if err != nil {
			return 0, nil, 500, err
		}
		amount := e.Amount
		rec, err := insertReturning(
			ctx, tx, id.String(), batch.HappenedAt, batch.UtcOffset, &amount, nil,
			tagsJSON, e.Memo, nil,
		)
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
