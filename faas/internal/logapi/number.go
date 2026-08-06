package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

// CreateNumberBatch 整单事务写入；成功返回 inserted 与行（供通知）。
// Body 顶层 happened_at 共享；entry numeric_value/memo 必填、tags/ai_analysis 可选。
// 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
func CreateNumberBatch(ctx context.Context, pool *pgxpool.Pool, raw []byte) (int, []record.Record, int, error) {
	return createNumberBatch(ctx, db.NewPoolTxBeginner(pool), raw)
}

func createNumberBatch(ctx context.Context, q db.TxBeginner, raw []byte) (int, []record.Record, int, error) {
	batch, err := numberdraft.ParseNumberBatch(raw)
	if err != nil {
		return 0, nil, 400, err
	}

	rows := make([]record.DBRow, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		tagsJSON, err := record.TagsJSON(e.Tags)
		if err != nil {
			return 0, nil, 500, err
		}
		id, err := uuid.NewV7()
		if err != nil {
			return 0, nil, 500, err
		}
		rows = append(rows, record.DBRow{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAt,
			UtcOffset:        batch.UtcOffset,
			NumericValue:     &e.NumericValue,
			RawContent:       nil,
			Tags:             tagsJSON,
			ObjectiveContext: e.ObjectiveContext,
			AiAnalysis:       e.AiAnalysis,
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
		return 0, nil, 500, err
	}
	return inserted, out, 201, nil
}
