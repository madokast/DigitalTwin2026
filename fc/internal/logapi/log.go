package logapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/draft"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

type NumberBody struct {
	HappenedAt               string   `json:"happened_at"`
	ValueNumber              any      `json:"value_number"`
	Tags                     []string `json:"tags"`
	ObjectiveContext         string   `json:"objective_context"`
	SubjectiveInterpretation any      `json:"subjective_interpretation"`
}

type TextBody struct {
	HappenedAt               string   `json:"happened_at"`
	ValueText                string   `json:"value_text"`
	Tags                     []string `json:"tags"`
	ObjectiveContext         string   `json:"objective_context"`
	SubjectiveInterpretation any      `json:"subjective_interpretation"`
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

func decodeNumberBody(raw []byte) (NumberBody, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var body NumberBody
	if err := dec.Decode(&body); err != nil {
		return NumberBody{}, fmt.Errorf("Invalid JSON body")
	}
	return body, nil
}

func CreateNumber(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	body, err := decodeNumberBody(raw)
	if err != nil {
		return record.Record{}, 400, err
	}
	happenedAt, err := draft.ParseHappenedAt(body.HappenedAt)
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
	if len(body.Tags) == 0 {
		return record.Record{}, 400, fmt.Errorf("Missing required field: tags (non-empty array)")
	}
	tv := tags.ValidateTags(body.Tags)
	if !tv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", tv.Error)
	}
	if rv := tags.AssertNoReservedTags(body.Tags); !rv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", rv.Error)
	}
	if body.ObjectiveContext == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: objective_context")
	}
	subj, err := optionalSubjective(body.SubjectiveInterpretation)
	if err != nil {
		return record.Record{}, 400, err
	}

	tagsJSON, err := record.TagsJSON(body.Tags)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}

	rec, err := insertReturning(
		ctx, pool, id.String(), happenedAt, numStr, nil,
		tagsJSON, body.ObjectiveContext, subj,
	)
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}

func CreateText(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	var body TextBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return record.Record{}, 400, fmt.Errorf("Invalid JSON body")
	}
	happenedAt, err := draft.ParseHappenedAt(body.HappenedAt)
	if err != nil {
		return record.Record{}, 400, err
	}
	if body.ValueText == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: value_text")
	}
	if len(body.Tags) == 0 {
		return record.Record{}, 400, fmt.Errorf("Missing required field: tags (non-empty array)")
	}
	tv := tags.ValidateTags(body.Tags)
	if !tv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", tv.Error)
	}
	if rv := tags.AssertNoReservedTags(body.Tags); !rv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", rv.Error)
	}
	if body.ObjectiveContext == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: objective_context")
	}
	subj, err := optionalSubjective(body.SubjectiveInterpretation)
	if err != nil {
		return record.Record{}, 400, err
	}

	tagsJSON, err := record.TagsJSON(body.Tags)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}
	vt := body.ValueText

	rec, err := insertReturning(
		ctx, pool, id.String(), happenedAt, nil, &vt,
		tagsJSON, body.ObjectiveContext, subj,
	)
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}
