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
	ValueNumber              any `json:"value_number"`
	Tags                     any `json:"tags"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
	SuppressNotification     any `json:"suppress_notification"`
}

type TextBody struct {
	HappenedAt               any `json:"happened_at"`
	ValueText                any `json:"value_text"`
	Tags                     any `json:"tags"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
	SuppressNotification     any `json:"suppress_notification"`
}

var logNumberKeys = []string{
	"happened_at", "value_number", "tags", "objective_context",
	"subjective_interpretation", "suppress_notification",
}

var logTextKeys = []string{
	"happened_at", "value_text", "tags", "objective_context",
	"subjective_interpretation", "suppress_notification",
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

// tagsStringSlice 与 Next createNumber/createText：非数组或空 → Missing tags；
// 元素非 string → tags must be an array of strings（与 PATCH draft 一致）。
func tagsStringSlice(raw any) ([]string, error) {
	tagList, ok := raw.([]any)
	if !ok {
		if sl, ok2 := raw.([]string); ok2 {
			tagList = make([]any, len(sl))
			for i, t := range sl {
				tagList[i] = t
			}
		} else {
			return nil, fmt.Errorf("Missing required field: tags (non-empty array)")
		}
	}
	if len(tagList) == 0 {
		return nil, fmt.Errorf("Missing required field: tags (non-empty array)")
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
	valueNumber *string,
	valueText *string,
	tagsJSON string,
	objectiveContext string,
	subj any,
) (record.Record, error) {
	var (
		outID, outTags, outObj   string
		outHappened              time.Time
		outNum, outText, outSubj *string
	)
	err := q.QueryRow(ctx, `
INSERT INTO records (id, happened_at, value_number, value_text, tags, objective_context, subjective_interpretation)
VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7)
RETURNING id, happened_at, value_number, value_text, tags, objective_context, subjective_interpretation
`, id, happenedAt, valueNumber, valueText, tagsJSON, objectiveContext, subj).Scan(
		&outID, &outHappened, &outNum, &outText, &outTags, &outObj, &outSubj,
	)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(outID, outHappened, outNum, outText, outTags, outObj, outSubj), nil
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
	happenedAt, err := draft.ParseHappenedAt(happenedAtString(body.HappenedAt))
	if err != nil {
		return record.Record{}, 400, err
	}
	if body.ValueNumber == nil {
		return record.Record{}, 400, fmt.Errorf("Missing required field: value_number")
	}
	numStr, err := draft.ParseValueNumber(body.ValueNumber)
	if err != nil {
		return record.Record{}, 400, err
	}
	if numStr == nil {
		return record.Record{}, 400, fmt.Errorf("Missing required field: value_number")
	}
	tagList, err := tagsStringSlice(body.Tags)
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
		ctx, pool, id.String(), happenedAt, numStr, nil,
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
	happenedAt, err := draft.ParseHappenedAt(happenedAtString(body.HappenedAt))
	if err != nil {
		return record.Record{}, 400, err
	}
	valueText, err := requireNonEmptyString(body.ValueText, "Missing required field: value_text")
	if err != nil {
		return record.Record{}, 400, err
	}
	tagList, err := tagsStringSlice(body.Tags)
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
		ctx, pool, id.String(), happenedAt, nil, &valueText,
		tagsJSON, objCtx, subj,
	)
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}
