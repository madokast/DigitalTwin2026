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
// 收 typed 产物（route 层经 transactiondraft.ParseTransactionBatch 解析校验）。
// Body 必填顶层 type（income|expense）；amount 为零 → 400。
func CreateTransactionBatch(ctx context.Context, pool *pgxpool.Pool, batch transactiondraft.NormalizedTransactionBatch) (int, string, string, []record.Record, int, error) {
	return createTransactionBatch(ctx, db.NewPoolTxBeginner(pool), batch)
}

func createTransactionBatch(ctx context.Context, q db.TxBeginner, batch transactiondraft.NormalizedTransactionBatch) (int, string, string, []record.Record, int, error) {
	// 领域 Record 组装（HappenedAt = 已校验请求串；Repository 内解析落库）。
	recs := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		id, err := uuid.NewV7()
		if err != nil {
			return 0, "", "", nil, 500, err
		}
		amount := e.Amount
		recs = append(recs, record.Record{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAtRaw,
			NumericValue:     &amount,
			RawContent:       nil,
			Tags:             e.Tags,
			ObjectiveContext: e.Memo,
			AiAnalysis:       nil,
		})
	}

	// 批量原子：业务层经 UoW 决定事务性；领域 Record 组装零 DB。
	var inserted int
	var out []record.Record
	err := db.WithTx(ctx, q, func(q db.Executor) error {
		res := recordrepo.Repo.SaveAll(ctx, q, recs)
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
