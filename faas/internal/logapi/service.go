package logapi

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/bodyweightdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/numberdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/reviewdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)

// Service 日志业务（§10b 步骤 4 定案：按包 Service，构造注入 db + uow）。
// 单条（无事务）用 db 直传 Repo；批量/多语句用 uow.Do（事务边界业务层职责）。
type Service struct {
	db  db.Executor // 单条路径（无事务）执行器：pool 或测试 fake（预读也走此——uow 只暴露 Do）
	uow *db.UoW
}

// NewService 构造（uow 由 db.NewUoW 装配；测试同包可注入 fake）。
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{db: pool, uow: db.NewUoW(pool)}
}

// CreateText 单条 text（无事务）。
func (s *Service) CreateText(ctx context.Context, body TextBody) (record.Record, *myerr.MyError) {
	happenedRaw := happenedAtString(body.HappenedAt)
	if me := draft.ValidateHappenedAt(happenedRaw); me != nil {
		return record.Record{}, me
	}
	rawContent, me := draft.RequireTrimmedText(body.RawContent, "raw_content")
	if me != nil {
		return record.Record{}, me
	}
	tagList, me := optionalTagList(body.Tags)
	if me != nil {
		return record.Record{}, me
	}
	if tv := tags.ValidateTags(tagList); !tv.Valid {
		return record.Record{}, myerr.NewValidation(tv.Error)
	}
	if rv := tags.AssertNoReservedTags(tagList); !rv.Valid {
		return record.Record{}, myerr.NewValidation(rv.Error)
	}
	objCtx, me := draft.RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if me != nil {
		return record.Record{}, me
	}
	subj, me := draft.OptionalTrimmedNullable(body.AiAnalysis, "ai_analysis")
	if me != nil {
		return record.Record{}, me
	}

	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	rec, me := recordrepo.Repo.Save(ctx, s.db, record.Record{
		ID:               id.String(),
		HappenedAt:       happenedRaw,
		NumericValue:     nil,
		RawContent:       &rawContent,
		Tags:             tagList,
		ObjectiveContext: objCtx,
		AiAnalysis:       subj,
	})
	if me != nil {
		return record.Record{}, me
	}
	return rec, nil
}

// CreateTodo 单条 todo（无事务）。
func (s *Service) CreateTodo(ctx context.Context, parsed tododraft.NormalizedTodo) (record.Record, *myerr.MyError) {
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	vt := parsed.RawContent
	rec, me := recordrepo.Repo.Save(ctx, s.db, record.Record{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     nil,
		RawContent:       &vt,
		Tags:             parsed.Tags,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       parsed.AiAnalysis,
	})
	if me != nil {
		return record.Record{}, me
	}
	return rec, nil
}

// CreateBodyWeight 单条 body weight（无事务）。
func (s *Service) CreateBodyWeight(ctx context.Context, parsed bodyweightdraft.NormalizedBodyWeight) (record.Record, *myerr.MyError) {
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	vn := parsed.NumericValue
	rec, me := recordrepo.Repo.Save(ctx, s.db, record.Record{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     &vn,
		RawContent:       nil,
		Tags:             parsed.Tags,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       parsed.AiAnalysis,
	})
	if me != nil {
		return record.Record{}, me
	}
	return rec, nil
}

// CreateReview 单条 review（无事务）。
func (s *Service) CreateReview(ctx context.Context, parsed reviewdraft.NormalizedReview) (record.Record, *myerr.MyError) {
	tagList := reviewdraft.ReviewTagsForCadence(parsed.Cadence, parsed.Tags)
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	rec, me := recordrepo.Repo.Save(ctx, s.db, record.Record{
		ID:               id.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     nil,
		RawContent:       &parsed.RawContent,
		Tags:             tagList,
		ObjectiveContext: parsed.ObjectiveContext,
		AiAnalysis:       parsed.AiAnalysis,
	})
	if me != nil {
		return record.Record{}, me
	}
	return rec, nil
}

// CreateNumberBatch 整单事务写入；成功返回 inserted 与行（供通知）。
func (s *Service) CreateNumberBatch(ctx context.Context, batch numberdraft.NormalizedNumberBatch) (int, []record.Record, *myerr.MyError) {
	recs := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		id, err := uuid.NewV7()
		if err != nil {
			return 0, nil, myerr.NewInternal(err)
		}
		recs = append(recs, record.Record{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAtRaw,
			NumericValue:     &e.NumericValue,
			RawContent:       nil,
			Tags:             e.Tags,
			ObjectiveContext: e.ObjectiveContext,
			AiAnalysis:       e.AiAnalysis,
		})
	}

	var inserted int
	var out []record.Record
	me := s.uow.Do(ctx, func(q db.Executor) *myerr.MyError {
		saved, me := recordrepo.Repo.SaveAll(ctx, q, recs)
		if me != nil {
			return me
		}
		inserted, out = len(saved), saved
		return nil
	})
	if me != nil {
		return 0, nil, me
	}
	return inserted, out, nil
}

// CreateTransactionBatch 整单事务写入（含 0 行）；返回 inserted、类型、金额合计、行。
func (s *Service) CreateTransactionBatch(ctx context.Context, batch transactiondraft.NormalizedTransactionBatch) (int, string, string, []record.Record, *myerr.MyError) {
	recs := make([]record.Record, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		id, err := uuid.NewV7()
		if err != nil {
			return 0, "", "", nil, myerr.NewInternal(err)
		}
		amount := e.Amount
		recs = append(recs, record.Record{
			ID:               id.String(),
			HappenedAt:       batch.HappenedAtRaw,
			NumericValue:     &amount,
			RawContent:       nil,
			Tags:             e.Tags,
			ObjectiveContext: e.Memo,
			AiAnalysis:       nil,
		})
	}

	var inserted int
	var out []record.Record
	me := s.uow.Do(ctx, func(q db.Executor) *myerr.MyError {
		saved, me := recordrepo.Repo.SaveAll(ctx, q, recs)
		if me != nil {
			return me
		}
		inserted, out = len(saved), saved
		return nil
	})
	if me != nil {
		return 0, "", "", nil, me
	}

	amounts := make([]string, 0, len(batch.Entries))
	for _, e := range batch.Entries {
		amounts = append(amounts, e.Amount)
	}
	return inserted, batch.Type, transactiondraft.SumMoneyAmounts(amounts), out, nil
}

// TransitionTodo 状态迁移（预读事务外 + 更新与审计事务内）。
func (s *Service) TransitionTodo(ctx context.Context, parsed tododraft.NormalizedTodoTransition) (TransitionResult, *myerr.MyError) {
	if !record.IsValidID(parsed.ID) {
		return TransitionResult{}, myerr.NewValidation(record.ErrInvalidID)
	}

	// 预读（非 CAS：只用于判断与组装，放事务外，事务持有时间最短）
	todoRec, me := recordrepo.Repo.FindByID(ctx, s.db, parsed.ID)
	if me != nil {
		// 404 文案映射为待办专属（契约）；其余（驱动错误）透传 myerr 500
		if me.IsNotFound() {
			return TransitionResult{}, myerr.NewNotFound(tododraft.ErrTodoNotFound)
		}
		return TransitionResult{}, me
	}

	tagList := todoRec.Tags
	if tododraft.IsTodoAuditRecordTags(tagList) {
		return TransitionResult{}, myerr.NewValidation(tododraft.ErrAuditTransition)
	}
	from := tododraft.TodoStateFromTags(tagList)
	if from == "" {
		return TransitionResult{}, myerr.NewValidation(tododraft.ErrNotATodo)
	}
	if from == parsed.Target {
		return TransitionResult{}, myerr.NewValidation(tododraft.ErrAlreadyTarget)
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
	auditRec := record.Record{
		ID:               auditID.String(),
		HappenedAt:       parsed.HappenedAtRaw,
		NumericValue:     nil,
		RawContent:       &content,
		Tags:             []string{tododraft.TodoTagTransition},
		ObjectiveContext: objCtx,
		AiAnalysis:       nil,
	}
	me = s.uow.Do(ctx, func(q db.Executor) *myerr.MyError {
		if me := recordrepo.Repo.Transition(ctx, q, todoRec.ID, newTags); me != nil {
			return me
		}
		_, me := recordrepo.Repo.Save(ctx, q, auditRec)
		if me != nil {
			return me
		}
		return nil
	})
	if me != nil {
		return TransitionResult{}, me
	}

	return TransitionResult{
		ID:                  todoRec.ID,
		From:                from,
		To:                  parsed.Target,
		TodoAuditNotifyText: notifyText,
	}, nil
}
