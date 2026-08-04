package logapi

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// 字段均为 any：与 Next 一样先 JSON 解成动态值再字段级校验，
// 避免 Go 强类型 decode 把类型错误一律变成 Invalid JSON body。
type NumberBody struct {
	HappenedAt               any `json:"happened_at"`
	NumericValue              any `json:"numeric_value"`
	Tags                     any `json:"tags"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
}

type TextBody struct {
	HappenedAt               any `json:"happened_at"`
	RawContent                any `json:"raw_content"`
	Tags                     any `json:"tags"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
}

var logNumberKeys = []string{
	"happened_at", "numeric_value", "tags", "objective_context",
	"subjective_interpretation",
}

var logTextKeys = []string{
	"happened_at", "raw_content", "tags", "objective_context",
	"subjective_interpretation",
}

// optionalSubjective 与 draft / PATCH 对齐：非 string → 错误；空串 / null / omit → nil
func optionalSubjective(raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("Invalid subjective_interpretation")
	}
	if s == "" {
		return nil, nil
	}
	return s, nil
}

func happenedAtString(raw any) string {
	s, _ := raw.(string)
	return s
}

func requireNonEmptyString(raw any, missingMsg string) (string, error) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("%s", missingMsg)
	}
	return s, nil
}

// optionalTagList 与 Next createNumber/createText：省略 / null / [] → []；
// 非数组或元素非 string → tags must be an array of strings（与 PATCH draft 一致）。
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
	return out, nil
}

// rowQuerier：pgxpool.Pool 与 pgx.Tx 均实现
type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func insertReturning(
	ctx context.Context,
	q rowQuerier,
	id string,
	happenedAt time.Time,
	utcOffset string,
	numericValue *string,
	rawContent *string,
	tagsJSON string,
	objectiveContext string,
	subj any,
) (record.Record, error) {
	var (
		outID, outTags, outObj, outOffset string
		outHappened                       time.Time
		outNum, outText, outSubj          *string
	)
	err := q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, subjective_interpretation)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, subjective_interpretation
`, id, happenedAt, utcOffset, numericValue, rawContent, tagsJSON, objectiveContext, subj).Scan(
		&outID, &outHappened, &outOffset, &outNum, &outText, &outTags, &outObj, &outSubj,
	)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(outID, outHappened, outOffset, outNum, outText, outTags, outObj, outSubj), nil
}

func decodeJSONBody(raw []byte, dest any) error {
	return jsonutil.DecodeUseNumber(raw, dest)
}

func CreateNumber(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	if err := jsonutil.RejectUnknownObjectKeys(raw, logNumberKeys); err != nil {
		return record.Record{}, 400, err
	}
	var body NumberBody
	if err := decodeJSONBody(raw, &body); err != nil {
		return record.Record{}, 400, err
	}
	happenedAt, utcOffset, err := draft.ParseHappenedAt(happenedAtString(body.HappenedAt))
	if err != nil {
		return record.Record{}, 400, err
	}
	if body.NumericValue == nil {
		return record.Record{}, 400, fmt.Errorf("Missing required field: numeric_value")
	}
	numStr, err := draft.ParseNumericValue(body.NumericValue)
	if err != nil {
		return record.Record{}, 400, err
	}
	if numStr == nil {
		return record.Record{}, 400, fmt.Errorf("Missing required field: numeric_value")
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
	objCtx, err := requireNonEmptyString(body.ObjectiveContext, "Missing required field: objective_context")
	if err != nil {
		return record.Record{}, 400, err
	}
	subj, err := optionalSubjective(body.SubjectiveInterpretation)
	if err != nil {
		return record.Record{}, 400, err
	}

	tagsJSON, err := record.TagsJSON(tagList)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	rec, err := insertReturning(
		ctx, pool, id.String(), happenedAt, utcOffset, numStr, nil,
		tagsJSON, objCtx, subj,
	)
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}

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
	rawContent, err := requireNonEmptyString(body.RawContent, "Missing required field: raw_content")
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
	objCtx, err := requireNonEmptyString(body.ObjectiveContext, "Missing required field: objective_context")
	if err != nil {
		return record.Record{}, 400, err
	}
	subj, err := optionalSubjective(body.SubjectiveInterpretation)
	if err != nil {
		return record.Record{}, 400, err
	}

	tagsJSON, err := record.TagsJSON(tagList)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	rec, err := insertReturning(
		ctx, pool, id.String(), happenedAt, utcOffset, nil, &rawContent,
		tagsJSON, objCtx, subj,
	)
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}
