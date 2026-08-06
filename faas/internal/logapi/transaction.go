package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// CreateTransactionBatch 整单事务写入；成功返回 inserted、type、sum（代数合计）与行（供 Telegram 摘要）。
// Body 必填顶层 type（income|expense）；amount 为零 → 400。
func CreateTransactionBatch(ctx context.Context, pool *pgxpool.Pool, raw []byte) (int, string, string, []record.Record, int, error) {
	return createTransactionBatch(ctx, db.NewPoolTxBeginner(pool), raw)
}

func createTransactionBatch(ctx context.Context, q db.TxBeginner, raw []byte) (int, string, string, []record.Record, int, error) {
	batch, err := transactiondraft.ParseTransactionBatch(raw)
	if err != nil {
		return 0, "", "", nil, 400, err
	}

	rows := make([]record.DBRow, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		tagsJSON, err := record.TagsJSON(e.Tags)
		if err != nil {
			return 0, "", "", nil, 500, err
		}
		id, err := uuid.NewV7()
		if err != nil {
			return 0, "", "", nil, 500, err
		}
		amount := e.Amount
		rows = append(rows, record.DBRow{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAt,
			UtcOffset:        batch.UtcOffset,
			NumericValue:     &amount,
			RawContent:       nil,
			Tags:             tagsJSON,
			ObjectiveContext: e.Memo,
			AiAnalysis:       nil,
		})
	}

	// 批量原子：业务层经 UoW 决定事务性；Rows 组装零 DB。
	var inserted int
	var out []record.Record
	err = db.WithTx(ctx, q, func(q db.Executor) error {
		res := recordrepo.New(q).SaveAll(ctx, rows)
		if !res.OK {
			return res.Error
		}
		inserted, out = len(res.Records), res.Records
		return nil
	})
	if err != nil {
		return 0, "", "", nil, 500, err
	}

	amounts := make([]string, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		amounts = append(amounts, e.Amount)
	}
	return inserted, batch.Type, transactiondraft.SumMoneyAmounts2(amounts), out, 201, nil
}
