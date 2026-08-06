// Package recordrepo 提供唯一聚合根 Record 的持久化（领域语义方法，内部写 SQL）。
//
// 硬约束：本包禁止开事务。Repository 方法显式收执行器 q——业务层传入的
// tx（事务内）或非事务 pool（直连），绝不调用 Begin/Commit/Rollback。
// 事务边界是业务层 UoW 的职责（db.WithTx）；业务层需要多方法同事务时，在 uow.Do
// 闭包内用同一个 q（= tx）依次调用本包方法，原子性由业务层这一个事务保证。
package recordrepo

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// RecordRepository 唯一聚合根的持久化：领域语义方法，内部写 SQL。
// 空结构体（无状态）；以包级单例 Repo 暴露，方法第一参数显式收执行器 q
// （非事务 pool 或事务 tx 调用形态一致）。
type RecordRepository struct{}

// Repo RecordRepository 包级单例（空结构体，无状态，安全共享）。
var Repo = &RecordRepository{}

// FindByID 按 id 查完整行：Scan → DBRow → FromDB（唯一转换点）→ 领域 Record；未找到 → myerr 404。
func (r *RecordRepository) FindByID(ctx context.Context, q db.Executor, id string) (record.Record, *myerr.MyError) {
	var row record.DBRow
	err := q.QueryRow(ctx, `
SELECT id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
FROM records WHERE id = $1
`, id).Scan(
		&row.ID, &row.HappenedAt, &row.UtcOffset, &row.NumericValue,
		&row.RawContent, &row.ObjectiveContext, &row.AiAnalysis, &row.Tags,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return record.Record{}, myerr.NewNotFound(fmt.Sprintf("record %s not found", id))
		}
		return record.Record{}, myerr.NewInternal(err)
	}
	return record.FromDB(row), nil
}

// Transition 只 UPDATE tags（WHERE id）；RowsAffected != 1 → 内部错误（D7：并发竞态文案含实际行数）。
// 领域规则（四态/审计/组装）在业务层；审计行由业务层调 Save 插入。nil = 成功。
func (r *RecordRepository) Transition(ctx context.Context, q db.Executor, id string, tags []string) *myerr.MyError {
	tagsJSON, me := record.TagsJSON(tags)
	if me != nil {
		return me
	}
	ct, err := q.Exec(ctx, `UPDATE records SET tags = $1 WHERE id = $2`, tagsJSON, id)
	if err != nil {
		return myerr.NewInternal(err)
	}
	if ct.RowsAffected() != 1 {
		return myerr.NewInternal(fmt.Errorf("todo update affected %d rows", ct.RowsAffected()))
	}
	return nil
}

// Save 单条 INSERT + RETURNING 完整行。rec 为领域 Record（HappenedAt 为业务层已校验的
// 请求串，Repository 内 ParseHappenedAt 解析落库——接受两次解析成本）；
// 返回规范化领域 Record（FromDB）——业务层唯一使用的 happened_at 来源。
func (r *RecordRepository) Save(ctx context.Context, q db.Executor, rec record.Record) (record.Record, *myerr.MyError) {
	happenedAt, utcOffset, me := draft.ParseHappenedAt(rec.HappenedAt)
	if me != nil {
		// 数据/格式问题 → 400 透传（业务层已校验，不可达防御；非第三方库错误）
		return record.Record{}, me
	}
	tagsJSON, me := record.TagsJSON(rec.Tags)
	if me != nil {
		return record.Record{}, me
	}
	var out record.DBRow
	err := q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
`, rec.ID, happenedAt, utcOffset, rec.NumericValue, rec.RawContent, rec.ObjectiveContext, rec.AiAnalysis, tagsJSON).Scan(
		&out.ID, &out.HappenedAt, &out.UtcOffset, &out.NumericValue,
		&out.RawContent, &out.ObjectiveContext, &out.AiAnalysis, &out.Tags,
	)
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}
	return record.FromDB(out), nil
}

// SaveAll 批量 INSERT（循环复用 Save 单条原语，行为与顺序确定）；事务内调用。
//
// TODO(perf)：当前是逐条 INSERT（N 次往返）。批量场景可优化为单条多值 INSERT
// （`INSERT ... VALUES (...),(...) ... RETURNING`）——但 PG 的 RETURNING 不保证与
// VALUES 顺序一致，需额外按 id ORDER BY（或临时表）恢复输入顺序。本项目 batch 量小暂未做。
func (r *RecordRepository) SaveAll(ctx context.Context, q db.Executor, recs []record.Record) ([]record.Record, *myerr.MyError) {
	out := make([]record.Record, 0, len(recs))
	for _, rec := range recs {
		saved, me := r.Save(ctx, q, rec)
		if me != nil {
			return nil, me
		}
		out = append(out, saved)
	}
	return out, nil
}
