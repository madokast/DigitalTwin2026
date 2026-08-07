package importapi

import (
	"context"
	"io"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// Service import 业务（§10b 步骤 4 定案）。
type Service struct {
	db *pgxpool.Pool
}

// NewService 构造。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{db: pool}
}

// ImportRecordsJSONL 读 file part（≤4MiB）后单事务逐行 upsert。
func (s *Service) ImportRecordsJSONL(ctx context.Context, r io.Reader) (record.ImportCounts, *myerr.MyError) {
	return ImportRecordsJSONL(ctx, s.db, r)
}
