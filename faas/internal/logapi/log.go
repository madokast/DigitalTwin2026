package logapi

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
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

// aiAnalysisPtr draft 解析产出的 any（string | nil）→ *string（领域行对象字段类型）。
func aiAnalysisPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// insertReturning 单条 INSERT + RETURNING 完整行（领域行对象 → API Record）。q 满足 db.Executor（pool 或事务 tx）。
func insertReturning(
	ctx context.Context,
	q db.Executor,
	row record.RecordRow,
) (record.Record, error) {
	tagsJSON, err := record.TagsJSON(row.Tags)
	if err != nil {
		return record.Record{}, err
	}
	var (
		outID, outTags, outObj, outOffset string
		outHappened                       time.Time
		outNum, outText, outSubj          *string
	)
	err = q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, objective_context, ai_analysis, tags
`, row.ID, row.HappenedAt, row.UtcOffset, row.NumericValue, row.RawContent, row.ObjectiveContext, row.AiAnalysis, tagsJSON).Scan(
		&outID, &outHappened, &outOffset, &outNum, &outText, &outObj, &outSubj, &outTags,
	)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(record.RecordRow{
		ID:               outID,
		HappenedAt:       outHappened,
		UtcOffset:        outOffset,
		NumericValue:     outNum,
		RawContent:       outText,
		Tags:             record.ParseTagsField(outTags),
		ObjectiveContext: outObj,
		AiAnalysis:       outSubj,
	}), nil
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
	happenedAt, utcOffset, err := draft.ParseHappenedAt(happenedAtString(body.HappenedAt))
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

	rec, err := insertReturning(ctx, pool, record.RecordRow{
		ID:               id.String(),
		HappenedAt:       happenedAt,
		UtcOffset:        utcOffset,
		NumericValue:     nil,
		RawContent:       &rawContent,
		Tags:             tagList,
		ObjectiveContext: objCtx,
		AiAnalysis:       subj,
	})
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}
