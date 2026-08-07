package query

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// Service 读路径业务（§10b 步骤 4 定案；读路径无事务，仅注入 db）。
type Service struct {
	db *pgxpool.Pool
}

// NewService 构造。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{db: pool}
}

// FetchFilteredRecords 列表（Count + FindByCriteria 组装）。
func (s *Service) FetchFilteredRecords(ctx context.Context, p *ParsedQuery) (*FetchResult, *myerr.MyError) {
	return FetchFilteredRecords(ctx, s.db, p)
}

// FetchSummary stats 计数。
func (s *Service) FetchSummary(ctx context.Context, tz string, now time.Time) (*SummaryResult, *myerr.MyError) {
	return FetchSummary(ctx, s.db, tz, now)
}

// FetchTagCounts 全表 tags 聚合计数。
func (s *Service) FetchTagCounts(ctx context.Context, prefix string) ([]tags.TagCount, *myerr.MyError) {
	return FetchTagCounts(ctx, s.db, prefix)
}

// FetchTransactionsSummary 区间汇总（分页循环 + 增量聚合）。
func (s *Service) FetchTransactionsSummary(ctx context.Context, from, to time.Time, fromRaw, toRaw string) (*TransactionsSummaryResult, *myerr.MyError) {
	return FetchTransactionsSummary(ctx, s.db, from, to, fromRaw, toRaw)
}
