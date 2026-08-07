package exportapi

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// Service export 业务（§10b 步骤 4 定案）。
type Service struct {
	db *pgxpool.Pool
}

// NewService 构造。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{db: pool}
}

// FetchExportRecords keyset 游标导出。
func (s *Service) FetchExportRecords(ctx context.Context, p *ParsedExport) ([]record.Record, *myerr.MyError) {
	return FetchExportRecords(ctx, s.db, p)
}
