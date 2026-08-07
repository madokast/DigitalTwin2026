package tags

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
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

// AttachTag 追加单个普通 tag（校验零 DB 已在 handler；此处 UoW 事务 + Repository 原语）。
func (s *Service) AttachTag(ctx context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
	return s.editTag(ctx, id, tag, recordrepo.Repo.AttachTag)
}

// DetachTag 删除单个普通 tag。
func (s *Service) DetachTag(ctx context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
	return s.editTag(ctx, id, tag, recordrepo.Repo.DetachTag)
}

// editTag 共用：UoW 事务包住 repo 原语（FOR UPDATE 行锁随本事务结束释放）。
func (s *Service) editTag(ctx context.Context, id, tag string, op func(context.Context, db.Executor, string, string) (recordrepo.EditTagsResult, *myerr.MyError)) (recordrepo.EditTagsResult, *myerr.MyError) {
	var res recordrepo.EditTagsResult
	me := db.WithTx(ctx, s.b, func(q db.Executor) *myerr.MyError {
		var opErr *myerr.MyError
		res, opErr = op(ctx, q, id, tag)
		return opErr
	})
	return res, me
}
