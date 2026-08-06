package logapi

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

type TextBody struct {
	HappenedAt       any `json:"happened_at"`
	RawContent       any `json:"raw_content"`
	ObjectiveContext any `json:"objective_context"`
	AiAnalysis       any `json:"ai_analysis"`
	Tags             any `json:"tags"`
}

var logTextKeys = []string{
	"happened_at", "raw_content", "objective_context",
	"ai_analysis", "tags",
}

// ParseTextBody 纯解析（reject unknown keys + decode，不校验语义）：route 层调用，
// 产出的 typed body 传给 CreateText（业务层校验 + 落库）。
func ParseTextBody(raw []byte) (TextBody, error) {
	var body TextBody
	if err := jsonutil.RejectUnknownObjectKeys(raw, logTextKeys); err != nil {
		return TextBody{}, err
	}
	if err := jsonutil.DecodeUseNumber(raw, &body); err != nil {
		return TextBody{}, err
	}
	return body, nil
}

func happenedAtString(raw any) string {
	s, _ := raw.(string)
	return s
}

// optionalTagList 与 Next createNumber/createText：省略 / null / [] → []；
// 非数组或元素非 string → tags must be an array of strings（与 Next draft 一致）。
func optionalTagList(raw any) ([]string, error) {
	if raw == nil {
		return []string{}, nil
	}
	tagList, ok := raw.([]any)
	if !ok {
		if sl, ok2 := raw.([]string); ok2 {
			tagList = make([]any, len(sl))
			for i, t := range sl {
				tagList[i] = t
			}
		} else {
			return nil, fmt.Errorf("tags must be an array of strings")
		}
	}
	out := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("tags must be an array of strings")
		}
		out = append(out, s)
	}
	if dup := tags.FirstDuplicateTag(out); dup != "" {
		return nil, fmt.Errorf("duplicate tag \"%s\"", dup)
	}
	return out, nil
}

// CreateText 与 Next createText 对齐：校验 + INSERT。收 typed 请求体（route 层已
// reject unknown keys + decode）；业务层只做字段校验与落库。
func CreateText(ctx context.Context, pool *pgxpool.Pool, body TextBody) (record.Record, error) {
	happenedRaw := happenedAtString(body.HappenedAt)
	if err := draft.ValidateHappenedAt(happenedRaw); err != nil {
		return record.Record{}, myerr.NewValidation(err.Error())
	}
	rawContent, err := draft.RequireTrimmedText(body.RawContent, "raw_content")
	if err != nil {
		return record.Record{}, myerr.NewValidation(err.Error())
	}
	tagList, err := optionalTagList(body.Tags)
	if err != nil {
		return record.Record{}, myerr.NewValidation(err.Error())
	}
	tv := tags.ValidateTags(tagList)
	if !tv.Valid {
		return record.Record{}, myerr.NewValidation(tv.Error)
	}
	if rv := tags.AssertNoReservedTags(tagList); !rv.Valid {
		return record.Record{}, myerr.NewValidation(rv.Error)
	}
	objCtx, err := draft.RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if err != nil {
		return record.Record{}, myerr.NewValidation(err.Error())
	}
	subj, err := draft.OptionalTrimmedNullable(body.AiAnalysis, "ai_analysis")
	if err != nil {
		return record.Record{}, myerr.NewValidation(err.Error())
	}

	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, myerr.NewInternal(err)
	}

	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record，业务层唯一使用。
	res := recordrepo.Repo.Save(ctx, pool, record.Record{
		ID:               id.String(),
		HappenedAt:       happenedRaw,
		NumericValue:     nil,
		RawContent:       &rawContent,
		Tags:             tagList,
		ObjectiveContext: objCtx,
		AiAnalysis:       subj,
	})
	if !res.OK {
		return record.Record{}, res.Error
	}
	return res.Record, nil
}
