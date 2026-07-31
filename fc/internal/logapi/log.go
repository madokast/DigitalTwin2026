package logapi

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/fc/internal/record"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

type NumberBody struct {
	HappenedAt               string   `json:"happened_at"`
	ValueNumber              *float64 `json:"value_number"`
	Tags                     []string `json:"tags"`
	ObjectiveContext         string   `json:"objective_context"`
	SubjectiveInterpretation *string  `json:"subjective_interpretation"`
}

type TextBody struct {
	HappenedAt               string   `json:"happened_at"`
	ValueText                string   `json:"value_text"`
	Tags                     []string `json:"tags"`
	ObjectiveContext         string   `json:"objective_context"`
	SubjectiveInterpretation *string  `json:"subjective_interpretation"`
}

func formatJSONNumber(v float64) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

func optionalSubjective(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

func insertReturning(
	ctx context.Context,
	pool *pgxpool.Pool,
	id string,
	happenedAt string,
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
	err := pool.QueryRow(ctx, `
INSERT INTO records (id, happened_at, value_number, value_text, tags, objective_context, subjective_interpretation)
VALUES ($1, $2::timestamptz, $3::numeric, $4, $5, $6, $7)
RETURNING id, happened_at, value_number::text, value_text, tags, objective_context, subjective_interpretation
`, id, happenedAt, valueNumber, valueText, tagsJSON, objectiveContext, subj).Scan(
		&outID, &outHappened, &outNum, &outText, &outTags, &outObj, &outSubj,
	)
	if err != nil {
		return record.Record{}, err
	}
	return record.FromDB(outID, outHappened, outNum, outText, outTags, outObj, outSubj), nil
}

func CreateNumber(ctx context.Context, pool *pgxpool.Pool, raw []byte) (record.Record, int, error) {
	var body NumberBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return record.Record{}, 400, fmt.Errorf("Invalid JSON body")
	}
	if body.HappenedAt == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: happened_at")
	}
	if body.ValueNumber == nil {
		return record.Record{}, 400, fmt.Errorf("Missing required field: value_number")
	}
	if len(body.Tags) == 0 {
		return record.Record{}, 400, fmt.Errorf("Missing required field: tags (non-empty array)")
	}
	tv := tags.ValidateTags(body.Tags)
	if !tv.Valid {
		return record.Record{}, 400, fmt.Errorf("%s", tv.Error)
	}
	if body.ObjectiveContext == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: objective_context")
	}

	tagsJSON, err := record.TagsJSON(body.Tags)
	if err != nil {
		return record.Record{}, 500, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return record.Record{}, 500, err
	}
	numStr := formatJSONNumber(*body.ValueNumber)

	rec, err := insertReturning(
		ctx, pool, id.String(), body.HappenedAt, &numStr, nil,
		tagsJSON, body.ObjectiveContext, optionalSubjective(body.SubjectiveInterpretation),
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
	if body.HappenedAt == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: happened_at")
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
	if body.ObjectiveContext == "" {
		return record.Record{}, 400, fmt.Errorf("Missing required field: objective_context")
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
		ctx, pool, id.String(), body.HappenedAt, nil, &vt,
		tagsJSON, body.ObjectiveContext, optionalSubjective(body.SubjectiveInterpretation),
	)
	if err != nil {
		return record.Record{}, 500, err
	}
	return rec, 201, nil
}
