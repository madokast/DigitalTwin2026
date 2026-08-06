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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

// Criteria 过滤 + 分页 + 排序条件（§6 定案）。
// 校验归属业务层（HTTP parse 填默认 page 1 / page_size 20 / sort 默认、上限 100 契约）；
// repo 内零默认、只检测非法值（Page<1 / PageSize<1 / SortBy/SortOrder 空或非法枚举 → 400）。
// Hint 不进 Criteria（响应辅助，业务层 parse 时产出、随响应返回）。
type Criteria struct {
	ID        string     // 空 = 无 id 过滤
	From, To  *time.Time // happened_at 区间（含 utc_offset 语义）
	Tags      []string   // 每项精确 tag 或 "family:*" 族通配；空 = 无 tag 过滤
	Q         string     // 全文搜索 raw_content / objective_context / ai_analysis / tags
	Page      int
	PageSize  int
	SortBy    string // happened_at | id
	SortOrder string // asc | desc
}

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

// FindByCriteria 按条件查询 records 列表（只返回行；total 由业务层另行 Count，方案 B）。
// 条件构建在 Repository 内部（D3：escapeLikePattern / 族通配 / recordsOrderBySql 迁入本包）。
// Scan DBRow + FromDB 唯一转换点。ID 非空时忽略分页返回 0～1 条（现状语义）。
// Criteria 非法值（Page/PageSize<1、SortBy/SortOrder 空或非法枚举）→ 400（§6：repo 只检测不填补）。
func (r *RecordRepository) FindByCriteria(ctx context.Context, q db.Executor, c Criteria) ([]record.Record, *myerr.MyError) {
	if me := validateCriteria(c); me != nil {
		return nil, me
	}

	where, args := buildCriteriaWhere(c)
	selectSQL := `SELECT id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, ai_analysis
FROM records`
	if where != "" {
		selectSQL += " WHERE " + where
	}
	selectSQL += " ORDER BY " + recordsOrderBySql(c.SortBy, c.SortOrder)
	if c.ID == "" {
		offset := (c.Page - 1) * c.PageSize
		selectSQL += fmt.Sprintf(" LIMIT %d OFFSET %d", c.PageSize, offset)
	}

	rows, err := q.Query(ctx, selectSQL, args...)
	if err != nil {
		return nil, myerr.NewInternal(err)
	}
	defer rows.Close()

	recs := []record.Record{}
	for rows.Next() {
		rec, err := scanRecordRow(rows)
		if err != nil {
			return nil, myerr.NewInternal(err)
		}
		recs = append(recs, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, myerr.NewInternal(err)
	}
	return recs, nil
}

// validateCriteria 检测非法值 → 400（错误语义：数据/格式问题不限层级）。
// 文案与 HTTP query parse 层一致（契约文案双端逐字一致）。
func validateCriteria(c Criteria) *myerr.MyError {
	if c.Page < 1 {
		return myerr.NewValidation("page must be a positive integer")
	}
	if c.PageSize < 1 {
		return myerr.NewValidation("page_size must be a positive integer")
	}
	if c.SortBy != "happened_at" && c.SortBy != "id" {
		return myerr.NewValidation("sort_by must be one of: happened_at, id")
	}
	if c.SortOrder != "asc" && c.SortOrder != "desc" {
		return myerr.NewValidation("sort_order must be one of: asc, desc")
	}
	return nil
}

// buildCriteriaWhere 构建 WHERE 子句（迁移自 query.buildWhere；步骤 8 接线后删旧实现）。
func buildCriteriaWhere(c Criteria) (string, []any) {
	var parts []string
	var args []any
	n := 1

	if c.ID != "" {
		parts = append(parts, fmt.Sprintf("id = $%d", n))
		args = append(args, c.ID)
		n++
	}
	if c.From != nil {
		parts = append(parts, fmt.Sprintf("happened_at >= $%d", n))
		args = append(args, *c.From)
		n++
	}
	if c.To != nil {
		parts = append(parts, fmt.Sprintf("happened_at < $%d", n))
		args = append(args, *c.To)
		n++
	}
	for _, tag := range c.Tags {
		parts = append(parts, fmt.Sprintf("tags LIKE $%d", n))
		pattern := `%"` + escapeLikePattern(tag) + `"%`
		if strings.HasSuffix(tag, ":*") {
			// 族通配 `X:*` → `%"X:%`（去尾闭合引号、保留冒号）
			pattern = `%"` + escapeLikePattern(tag[:len(tag)-1]) + `%`
		}
		args = append(args, pattern)
		n++
	}
	if c.Q != "" {
		pattern := `%` + escapeLikePattern(c.Q) + `%`
		parts = append(parts, fmt.Sprintf(
			`(raw_content LIKE $%d OR objective_context LIKE $%d OR ai_analysis LIKE $%d OR tags LIKE $%d)`,
			n, n+1, n+2, n+3,
		))
		args = append(args, pattern, pattern, pattern, pattern)
	}

	if len(parts) == 0 {
		return "", nil
	}
	return strings.Join(parts, " AND "), args
}

// escapeLikePattern 转义 LIKE 通配符（PostgreSQL 默认 ESCAPE '\'）。
// 迁移自 query.EscapeLikePattern；步骤 8 接线后删旧实现。
func escapeLikePattern(raw string) string {
	s := strings.ReplaceAll(raw, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

// recordsOrderBySql 列表查询排序（迁移自 query.RecordsOrderBySql；步骤 8 接线后删旧实现）。
func recordsOrderBySql(sortBy, sortOrder string) string {
	if sortBy == "id" {
		if sortOrder == "desc" {
			return "id DESC"
		}
		return "id ASC"
	}
	if sortOrder == "desc" {
		return "happened_at DESC, id ASC"
	}
	return "happened_at ASC, id ASC"
}

// rowScanner 收窄的扫描接口（pgx.Rows / pgx.Row 均满足）。
type rowScanner interface {
	Scan(dest ...any) error
}

// scanRecordRow Scan DBRow → FromDB（迁移自 query.scanRecord；唯一转换点）。
func scanRecordRow(row rowScanner) (record.Record, error) {
	var (
		id, tagsField, objectiveContext, utcOffset string
		happenedAt                                 time.Time
		numericValue, rawContent, subj             *string
	)
	err := row.Scan(&id, &happenedAt, &utcOffset, &numericValue, &rawContent, &tagsField, &objectiveContext, &subj)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(record.DBRow{
		ID:               id,
		HappenedAt:       happenedAt,
		UtcOffset:        utcOffset,
		NumericValue:     numericValue,
		RawContent:       rawContent,
		Tags:             tagsField,
		ObjectiveContext: objectiveContext,
		AiAnalysis:       subj,
	}), nil
}
