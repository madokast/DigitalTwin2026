package logapi

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// CreateTodo 与 Next createTodo 对齐：解析委托 tododraft，落库强制含 todo:in_progress。
// 返回内部 Record；HTTP 层再用 tododraft.ToTodoRecordJSON 变形响应。
func CreateTodo(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	parsed, err := tododraft.ParseTodo(raw)
	if err != nil {
		return record.Record{}, 400, err
	}

	tagsJSON, err := record.TagsJSON(parsed.Tags)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	vt := parsed.RawContent
	rec, err := insertReturning(
		ctx, pool, id.String(), parsed.HappenedAt, parsed.UtcOffset, nil, &vt,
		tagsJSON, parsed.ObjectiveContext, parsed.AiAnalysis,
	)
	if err != nil {
		return record.Record{}, 500, fmt.Errorf("insert todo: %w", err)
	}
	return rec, 201, nil
}

// TransitionResult 成功流转结果（供 HTTP 组 200 JSON + notify）。
type TransitionResult struct {
	ID                  string
	From                string
	To                  string
	TodoAuditNotifyText string
}

func parseTagsList(tagsJSON string) ([]string, error) {
	var raw []any
	if err := json.Unmarshal([]byte(tagsJSON), &raw); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		s, ok := item.(string)
		if !ok {
			continue
		}
		out = append(out, s)
	}
	return out, nil
}

// TransitionTodo 与 Next transitionTodo 对齐：同事务 UPDATE 状态 tag + INSERT 审计。
// pool 满足 db.TxBeginner（*pgxpool.Pool 天然满足）；单测直接调 transitionTodo 注入 fake。
func TransitionTodo(ctx context.Context, pool *pgxpool.Pool, raw []byte) (TransitionResult, int, error) {
	return transitionTodo(ctx, pool, raw)
}

func transitionTodo(ctx context.Context, q db.TxBeginner, raw []byte) (TransitionResult, int, error) {
	parsed, err := tododraft.ParseTodoTransition(raw)
	if err != nil {
		return TransitionResult{}, 400, err
	}
	if !record.IsValidID(parsed.ID) {
		return TransitionResult{}, 400, record.ErrInvalidID
	}

	var (
		todoID, todoTags, todoObj, todoOffset string
		todoHappened                          time.Time
		todoNum, todoText, todoSubj           *string
	)
	err = q.QueryRow(ctx, `
SELECT id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, ai_analysis
FROM records WHERE id = $1
`, parsed.ID).Scan(
		&todoID, &todoHappened, &todoOffset, &todoNum, &todoText, &todoTags, &todoObj, &todoSubj,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return TransitionResult{}, 404, fmt.Errorf("%w", tododraft.ErrTodoNotFound)
		}
		return TransitionResult{}, 500, err
	}

	tagList, err := parseTagsList(todoTags)
	if err != nil {
		return TransitionResult{}, 500, err
	}

	if tododraft.IsTodoAuditRecordTags(tagList) {
		return TransitionResult{}, 400, fmt.Errorf("%w", tododraft.ErrAuditTransition)
	}
	from := tododraft.TodoStateFromTags(tagList)
	if from == "" {
		return TransitionResult{}, 400, fmt.Errorf("%w", tododraft.ErrNotATodo)
	}
	if from == parsed.Target {
		return TransitionResult{}, 400, fmt.Errorf("%w", tododraft.ErrAlreadyTarget)
	}

	todoRec := record.FromDB(todoID, todoHappened, todoOffset, todoNum, todoText, todoTags, todoObj, todoSubj)
	content := ""
	if todoRec.RawContent != nil {
		content = *todoRec.RawContent
	}
	notifyText := tododraft.TodoAuditNotifyText(parsed.Target, parsed.ID, todoRec.HappenedAt, content)
	objCtx := tododraft.AuditObjectiveContext(parsed.Target, todoID, todoRec.HappenedAt)
	newTags := tododraft.ReplaceTodoStateInTags(tagList, parsed.Target)
	newTagsJSON, err := record.TagsJSON(newTags)
	if err != nil {
		return TransitionResult{}, 500, err
	}
	auditTagsJSON, err := record.TagsJSON([]string{tododraft.TodoTagTransition})
	if err != nil {
		return TransitionResult{}, 500, err
	}
	auditID, err := uuid.NewV7()
	if err != nil {
		return TransitionResult{}, 500, err
	}

	tx, err := q.Begin(ctx)
	if err != nil {
		return TransitionResult{}, 500, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ct, err := tx.Exec(ctx, `UPDATE records SET tags = $1 WHERE id = $2`, newTagsJSON, todoID)
	if err != nil {
		return TransitionResult{}, 500, err
	}
	if ct.RowsAffected() != 1 {
		return TransitionResult{}, 500, fmt.Errorf("todo update affected %d rows", ct.RowsAffected())
	}

	vt := content
	_, err = insertReturning(
		ctx, tx, auditID.String(), parsed.HappenedAt, parsed.UtcOffset, nil, &vt,
		auditTagsJSON, objCtx, nil,
	)
	if err != nil {
		return TransitionResult{}, 500, fmt.Errorf("insert todo audit: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return TransitionResult{}, 500, err
	}

	return TransitionResult{
		ID:                  todoID,
		From:                from,
		To:                  parsed.Target,
		TodoAuditNotifyText: notifyText,
	}, 200, nil
}
