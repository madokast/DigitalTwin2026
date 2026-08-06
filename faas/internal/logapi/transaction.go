package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// CreateTransactionBatch 整单事务写入；成功返回 inserted、type、sum（代数合计）与行（供 Telegram 摘要）。
// Body 必填顶层 type（income|expense）；amount 为零 → 400。
func CreateTransactionBatch(ctx context.Context, pool *pgxpool.Pool, raw []byte) (int, string, string, []record.Record, int, error) {
	batch, err := transactiondraft.ParseTransactionBatch(raw)
	if err != nil {
		return 0, "", "", nil, 400, err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, "", "", nil, 500, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		id, err := uuid.NewV7()
		if err != nil {
			return 0, "", "", nil, 500, err
		}
		amount := e.Amount
		rec, err := insertReturning(ctx, tx, record.RecordRow{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAt,
			UtcOffset:        batch.UtcOffset,
			NumericValue:     &amount,
			RawContent:       nil,
			Tags:             e.Tags,
			ObjectiveContext: e.Memo,
			AiAnalysis:       nil,
		})
		if err != nil {
			return 0, "", "", nil, 500, err
		}
		out = append(out, rec)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", "", nil, 500, err
	}
	amounts := make([]string, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		amounts = append(amounts, e.Amount)
	}
	return len(out), batch.Type, transactiondraft.SumMoneyAmounts2(amounts), out, 201, nil
}
