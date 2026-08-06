package db

import (
	"context"
)

// UoW 事务机制封装（begin / rollback / commit）。业务层只调 Do，不碰事务机制实现。
// 构造注入事务起点（*pgxpool.Pool）；单测可注入 fake。
type UoW struct {
	pool TxBeginner
}

func NewUoW(pool TxBeginner) *UoW {
	return &UoW{pool: pool}
}

// Do 闭包式事务：fn 返回 nil → Commit；返回 error → Rollback 并透传该 error。
// fn 收到的 q 满足 Executor（事务上下文执行器），供 Repository 构造注入。
func (u *UoW) Do(ctx context.Context, fn func(q Executor) error) error {
	tx, err := u.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
