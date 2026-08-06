package logapi

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// CreateTodo 与 Next createTodo 对齐：解析委托 tododraft，落库强制含 todo:in_progress。
// 返回内部 Record；HTTP 层再用 tododraft.ToTodoRecordJSON 变形响应。
func CreateTodo(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	parsed, err := tododraft.ParseTodo(raw)
	if err != nil {
		return record.Record{}, 400, err
	}

	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	vt := parsed.RawContent
	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record。
	res := recordrepo.New(pool).Save(ctx, record.NewRecord{
		ID: id.String(),
		HappenedAt: draft.DateTimeWithOffset{
			Time:   parsed.HappenedAt,
			Offset: parsed.UtcOffset,
		},
		NumericValue:     nil,
		RawContent:       &vt,
		Tags:             parsed.Tags,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       aiAnalysisPtr(parsed.AiAnalysis),
	})
	if !res.OK {
		return record.Record{}, 500, fmt.Errorf("insert todo: %w", res.Error)
	}
	return res.Record, 201, nil
}

// TransitionResult 成功流转结果（供 HTTP 组 200 JSON + notify）。
type TransitionResult struct {
	ID                  string
	From                string
	To                  string
	TodoAuditNotifyText string
}

// TransitionTodo 与 Next transitionTodo 对齐：同事务 UPDATE 状态 tag + INSERT 审计。
// pool 经 db.NewPoolTxBeginner 适配为 TxBeginner；单测直接调 transitionTodo 注入 fake。
func TransitionTodo(ctx context.Context, pool *pgxpool.Pool, raw []byte) (TransitionResult, int, error) {
	return transitionTodo(ctx, db.NewPoolTxBeginner(pool), raw)
}

func transitionTodo(ctx context.Context, q db.TxBeginner, raw []byte) (TransitionResult, int, error) {
	parsed, err := tododraft.ParseTodoTransition(raw)
	if err != nil {
		return TransitionResult{}, 400, err
	}
	if !record.IsValidID(parsed.ID) {
		return TransitionResult{}, 400, record.ErrInvalidID
	}

	// 预读（非 CAS：只用于判断与组装，放事务外，事务持有时间最短）
	res := recordrepo.New(q).FindByID(ctx, parsed.ID)
	if !res.OK {
		switch {
		case errors.Is(res.Error, record.ErrNotFound):
			return TransitionResult{}, 404, fmt.Errorf("%w", tododraft.ErrTodoNotFound)
		default:
			return TransitionResult{}, 500, res.Error
		}
	}
	todoRec := res.Record

	tagList := todoRec.Tags
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

	content := ""
	if todoRec.RawContent != nil {
		content = *todoRec.RawContent
	}
	notifyText := tododraft.TodoAuditNotifyText(parsed.Target, parsed.ID, todoRec.HappenedAt, content)
	objCtx := tododraft.AuditObjectiveContext(parsed.Target, parsed.ID, todoRec.HappenedAt)
	newTags := tododraft.ReplaceTodoStateInTags(tagList, parsed.Target)
	auditID, err := uuid.NewV7()
	if err != nil {
		return TransitionResult{}, 500, err
	}

	// 审计行 happened_at 与请求一致（parse 产物 time + offset 组装值对象，零额外解析）
	// 写路径：UPDATE 状态 tag + INSERT 审计，原子（业务层经 UoW 决定事务性）
	auditRec := record.NewRecord{
		ID: auditID.String(),
		HappenedAt: draft.DateTimeWithOffset{
			Time:   parsed.HappenedAt,
			Offset: parsed.UtcOffset,
		},
		NumericValue:     nil,
		RawContent:       &content,
		Tags:             []string{tododraft.TodoTagTransition},
		ObjectiveContext: objCtx,
		AiAnalysis:       nil,
	}
	err = db.WithTx(ctx, q, func(q db.Executor) error {
		repo := recordrepo.New(q)
		tRes := repo.Transition(ctx, todoRec.ID, newTags)
		if !tRes.OK {
			return tRes.Error
		}
		aRes := repo.Save(ctx, auditRec)
		if !aRes.OK {
			return fmt.Errorf("insert todo audit: %w", aRes.Error)
		}
		return nil
	})
	if err != nil {
		return TransitionResult{}, 500, err
	}

	return TransitionResult{
		ID:                  todoRec.ID,
		From:                from,
		To:                  parsed.Target,
		TodoAuditNotifyText: notifyText,
	}, 200, nil
}
