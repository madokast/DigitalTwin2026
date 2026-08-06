package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

// CreateTodo 与 Next createTodo 对齐：落库强制含 todo:in_progress。
// 收 typed 产物（route 层经 tododraft.ParseTodo 解析校验）。
// 返回内部 Record；HTTP 层再用 tododraft.ToTodoRecordJSON 变形响应。
func CreateTodo(ctx context.Context, pool *pgxpool.Pool, parsed tododraft.NormalizedTodo) (record.Record, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	vt := parsed.RawContent
	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record。
	res := recordrepo.Repo.Save(ctx, pool, record.Record{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     nil,
		RawContent:       &vt,
		Tags:             parsed.Tags,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       parsed.AiAnalysis,
	})
	if !res.OK {
		return record.Record{}, res.Error
	}
	return res.Record, nil
}

// TransitionResult 成功流转结果（供 HTTP 组 200 JSON + notify）。
type TransitionResult struct {
	ID                  string
	From                string
	To                  string
	TodoAuditNotifyText string
}

// TransitionTodo 与 Next transitionTodo 对齐：同事务 UPDATE 状态 tag + INSERT 审计。
// 收 typed 产物（route 层经 tododraft.ParseTodoTransition 解析校验）。
// pool 经 db.NewPoolTxBeginner 适配为 TxBeginner；单测直接调 transitionTodo 注入 fake。
func TransitionTodo(ctx context.Context, pool *pgxpool.Pool, parsed tododraft.NormalizedTodoTransition) (TransitionResult, error) {
	return transitionTodo(ctx, db.NewPoolTxBeginner(pool), parsed)
}

func transitionTodo(ctx context.Context, q db.TxBeginner, parsed tododraft.NormalizedTodoTransition) (TransitionResult, error) {
	if !record.IsValidID(parsed.ID) {
		return TransitionResult{}, myerr.NewValidation(record.ErrInvalidID.Error())
	}

	// 预读（非 CAS：只用于判断与组装，放事务外，事务持有时间最短）
	res := recordrepo.Repo.FindByID(ctx, q, parsed.ID)
	if !res.OK {
		// 404 文案映射为待办专属（契约）；其余（驱动错误）透传 myerr 500
		if me, ok := res.Error.(*myerr.MyError); ok && me.Status == 404 {
			return TransitionResult{}, myerr.NewNotFound(tododraft.ErrTodoNotFound.Error())
		}
		return TransitionResult{}, res.Error
	}
	todoRec := res.Record

	tagList := todoRec.Tags
	if tododraft.IsTodoAuditRecordTags(tagList) {
		return TransitionResult{}, myerr.NewValidation(tododraft.ErrAuditTransition.Error())
	}
	from := tododraft.TodoStateFromTags(tagList)
	if from == "" {
		return TransitionResult{}, myerr.NewValidation(tododraft.ErrNotATodo.Error())
	}
	if from == parsed.Target {
		return TransitionResult{}, myerr.NewValidation(tododraft.ErrAlreadyTarget.Error())
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
		return TransitionResult{}, myerr.NewInternal(err)
	}

	// 审计行 happened_at 与请求一致（已校验请求串；Repository 内解析落库）
	// 写路径：UPDATE 状态 tag + INSERT 审计，原子（业务层经 UoW 决定事务性）
	auditRec := record.Record{
		ID:               auditID.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     nil,
		RawContent:       &content,
		Tags:             []string{tododraft.TodoTagTransition},
		ObjectiveContext: objCtx,
		AiAnalysis:       nil,
	}
	err = db.WithTx(ctx, q, func(q db.Executor) error {
		tRes := recordrepo.Repo.Transition(ctx, q, todoRec.ID, newTags)
		if !tRes.OK {
			return tRes.Error
		}
		aRes := recordrepo.Repo.Save(ctx, q, auditRec)
		if !aRes.OK {
			return aRes.Error
		}
		return nil
	})
	if err != nil {
		return TransitionResult{}, err
	}

	return TransitionResult{
		ID:                  todoRec.ID,
		From:                from,
		To:                  parsed.Target,
		TodoAuditNotifyText: notifyText,
	}, nil
}
