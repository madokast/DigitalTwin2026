package tags

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
)

// Service tags 写路径业务（§10b 步骤 4 定案）。
type Service struct {
	b db.TxBeginner
}

// NewService 构造。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{b: db.NewPoolTxBeginner(pool)}
}

// RenameAcrossRecords 单事务内全表改名（锁 + 分页循环）。
func (s *Service) RenameAcrossRecords(ctx context.Context, from, to string) (int, *myerr.MyError) {
	return RenameAcrossRecords(ctx, s.b, from, to)
}
