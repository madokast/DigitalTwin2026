package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

// CreateNumberBatch 整单事务写入；成功返回 inserted 与行（供通知）。
// 收 typed 产物（route 层经 numberdraft.ParseNumberBatch 解析校验）。
// Body 顶层 happened_at 共享；entry numeric_value/memo 必填、tags/ai_analysis 可选。
// 落库：numeric_value → numeric_value；memo → objective_context；raw_content = NULL。
func CreateNumberBatch(ctx context.Context, pool *pgxpool.Pool, batch numberdraft.NormalizedNumberBatch) (int, []record.Record, *myerr.MyError) {
	return createNumberBatch(ctx, db.NewPoolTxBeginner(pool), batch)
}

func createNumberBatch(ctx context.Context, q db.TxBeginner, batch numberdraft.NormalizedNumberBatch) (int, []record.Record, *myerr.MyError) {
	// 领域 Record 组装（HappenedAt = 已校验请求串；Repository 内解析落库）。
	recs := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		id, err := uuid.NewV7()
		if err != nil {
			return 0, nil, myerr.NewInternal(err)
		}
		recs = append(recs, record.Record{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAtRaw,
			NumericValue:     &e.NumericValue,
			RawContent:       nil,
			Tags:             e.Tags,
			ObjectiveContext: e.ObjectiveContext,
			AiAnalysis:       e.AiAnalysis,
		})
	}

	// 批量原子：业务层经 UoW 决定事务性；领域 Record 组装零 DB。
	var inserted int
	var out []record.Record
	me := db.WithTx(ctx, q, func(q db.Executor) *myerr.MyError {
		saved, me := recordrepo.Repo.SaveAll(ctx, q, recs)
		if me != nil {
			return me
		}
		inserted, out = len(saved), saved
		return nil
	})
	if me != nil {
		return 0, nil, me
	}
	return inserted, out, nil
}
