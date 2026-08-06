package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
)

// txAdapter 包装 pgx.Tx 为自定义 Tx（pgx 类型不出 db 包；Begin 返回类型不协变的适配层）。
type txAdapter struct{ tx pgx.Tx }

func (a *txAdapter) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return a.tx.QueryRow(ctx, sql, args...)
}
func (a *txAdapter) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return a.tx.Exec(ctx, sql, args...)
}
func (a *txAdapter) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return a.tx.Query(ctx, sql, args...)
}
func (a *txAdapter) Commit(ctx context.Context) error {
	return a.tx.Commit(ctx)
}
func (a *txAdapter) Rollback(ctx context.Context) error {
	return a.tx.Rollback(ctx)
}

// poolTxBeginner 适配 *pgxpool.Pool 为 TxBeginner（Begin 返回自定义 Tx）。
type poolTxBeginner struct{ pool *pgxpool.Pool }

func (p *poolTxBeginner) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return p.pool.QueryRow(ctx, sql, args...)
}
func (p *poolTxBeginner) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return p.pool.Exec(ctx, sql, args...)
}
func (p *poolTxBeginner) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return p.pool.Query(ctx, sql, args...)
}
func (p *poolTxBeginner) Begin(ctx context.Context) (Tx, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &txAdapter{tx: tx}, nil
}

// NewPoolTxBeginner 把 *pgxpool.Pool 适配为 TxBeginner（nil → nil，保持调用方语义）。
// 装配处 / 过渡期业务函数（如 transitionTodo 注入点）使用。
func NewPoolTxBeginner(pool *pgxpool.Pool) TxBeginner {
	if pool == nil {
		return nil
	}
	return &poolTxBeginner{pool: pool}
}

// UoW 事务机制封装（begin / rollback / commit）。业务层只调 Do，不碰事务机制实现。
// 构造注入 *pgxpool.Pool（内部适配为 TxBeginner）；单测同包直接注入 fake。
type UoW struct {
	pool TxBeginner
}

func NewUoW(pool *pgxpool.Pool) *UoW {
	return &UoW{pool: NewPoolTxBeginner(pool)}
}

// WithTx 闭包式事务（函数形态，接受任意 TxBeginner——测试可注入 fake）：
// fn 返回 nil → Commit；返回 *MyError → Rollback 并透传。fn 收到的 q 满足 Executor。
// 第三方驱动错误（Begin/Commit）在此统一包装为 myerr.NewInternal（决策 D）。
func WithTx(ctx context.Context, b TxBeginner, fn func(q Executor) *myerr.MyError) *myerr.MyError {
	tx, err := b.Begin(ctx)
	if err != nil {
		return myerr.NewInternal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if me := fn(tx); me != nil {
		return me
	}
	if err := tx.Commit(ctx); err != nil {
		return myerr.NewInternal(err)
	}
	return nil
}

// Do UoW 对象形态的 WithTx（Service 构造注入 UoW 后调用）。
func (u *UoW) Do(ctx context.Context, fn func(q Executor) *myerr.MyError) *myerr.MyError {
	return WithTx(ctx, u.pool, fn)
}
