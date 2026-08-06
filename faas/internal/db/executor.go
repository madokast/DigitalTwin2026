package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Executor 可执行 SQL 的句柄（读路径 / 事务内操作）。仅 Repository / UoW 内部使用。
// *pgxpool.Pool 与 pgx.Tx 均满足；单测可假实现。取代散落的 rowQuerier / transitionDB / db.Querier。
type Executor interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Tx 事务句柄 = Executor + 提交/回滚。pgx.Tx 满足。
type Tx interface {
	Executor
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

// TxBeginner 能开事务的入口（自定义 Tx 抽象，pgx 类型不出 db 包）。
// *pgxpool.Pool（经 NewPoolTxBeginner 适配）与 pgx.Tx（savepoint 嵌套，同上适配）满足。
type TxBeginner interface {
	Executor
	Begin(ctx context.Context) (Tx, error)
}
