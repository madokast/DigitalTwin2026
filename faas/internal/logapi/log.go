package logapi

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
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

// aiAnalysisPtr draft 解析产出的 any（string | nil）→ *string（NewRecord 字段类型）。
func aiAnalysisPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func decodeJSONBody(raw []byte, dest any) error {
	return jsonutil.DecodeUseNumber(raw, dest)
}

// CreateText 与 Next createText 对齐：校验 + INSERT。
func CreateText(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logTextKeys); err != nil {
		return record.Record{}, 400, err
	}
	var body TextBody
	if err := decodeJSONBody(raw, &body); err != nil {
		return record.Record{}, 400, err
	}
	dt, err := draft.NormalizeHappenedAt(happenedAtString(body.HappenedAt))
	if err != nil {
		return record.Record{}, 400, err
	}
	rawContent, err := draft.RequireTrimmedText(body.RawContent, "raw_content")
	if err != nil {
		return record.Record{}, 400, err
	}
	tagList, err := optionalTagList(body.Tags)
	if err != nil {
		return record.Record{}, 400, err
	}
	tv := tags.ValidateTags(tagList)
	if !tv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", tv.Error)
	}
	if rv := tags.AssertNoReservedTags(tagList); !rv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", rv.Error)
	}
	objCtx, err := draft.RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if err != nil {
		return record.Record{}, 400, err
	}
	subj, err := draft.OptionalTrimmedNullable(body.AiAnalysis, "ai_analysis")
	if err != nil {
		return record.Record{}, 400, err
	}

	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	// 单条 INSERT：无事务（pool 当 Executor）；返回规范化领域 Record，业务层唯一使用。
	res := recordrepo.Repo.Save(ctx, pool, record.NewRecord{
		ID:               id.String(),
		HappenedAt:       dt,
		NumericValue:     nil,
		RawContent:       &rawContent,
		Tags:             tagList,
		ObjectiveContext: objCtx,
		AiAnalysis:       subj,
	})
	if !res.OK {
		return record.Record{}, 500, res.Error
	}
	return res.Record, 201, nil
}
