package record

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/fc/internal/db"
	"github.com/mdk/digitaltwin2026/fc/internal/draft"
)

// Record matches Next/Drizzle JSON shape (camelCase).
type Record struct {
	ID                       string  `json:"id"`
	HappenedAt               string  `json:"happenedAt"`
	ValueNumber              *string `json:"valueNumber"`
	ValueText                *string `json:"valueText"`
	Tags                     string  `json:"tags"`
	ObjectiveContext         string  `json:"objectiveContext"`
	SubjectiveInterpretation *string `json:"subjectiveInterpretation"`
}

func FormatHappenedAt(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func FromDB(
	id string,
	happenedAt time.Time,
	valueNumber *string,
	valueText *string,
	tags string,
	objectiveContext string,
	subjectiveInterpretation *string,
) Record {
	return Record{
		ID:                       id,
		HappenedAt:               FormatHappenedAt(happenedAt),
		ValueNumber:              valueNumber,
		ValueText:                valueText,
		Tags:                     tags,
		ObjectiveContext:         objectiveContext,
		SubjectiveInterpretation: subjectiveInterpretation,
	}
}

func TagsJSON(tags []string) (string, error) {
	b, err := json.Marshal(tags)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ErrNotFound 与 TS RECORD_NOT_FOUND 同文案；Update 在无行时返回。
var ErrNotFound = fmt.Errorf("Record not found")

// InvalidID 与 TS INVALID_RECORD_ID 同文案：非 UUID → 400，避免 PG 类型错误变 500。
var InvalidID = errors.New("Invalid record id")

// IsValidID 与 Next isValidRecordId 对齐（google/uuid.Parse）。
func IsValidID(id string) bool {
	_, err := uuid.Parse(id)
	return err == nil
}

// Update 按已归一化草稿更新一条记录；成功 (rec, 200, nil)；不存在 (空, 404, err)。
// q 为可注入 Querier（*pgxpool.Pool 或测试假实现）。
func Update(ctx context.Context, q db.Querier, id string, d *draft.NormalizedRecordDraft) (Record, int, error) {
	if !IsValidID(id) {
		return Record{}, 400, InvalidID
	}
	tagsJSON, err := TagsJSON(d.Tags)
	if err != nil {
		return Record{}, 500, err
	}

	var (
		outID, outTags, outObj   string
		outHappened              time.Time
		outNum, outText, outSubj *string
	)
	err = q.QueryRow(ctx, `
UPDATE records SET
  happened_at = $1,
  value_number = $2,
  value_text = $3,
  tags = $4,
  objective_context = $5,
  subjective_interpretation = $6
WHERE id = $7
RETURNING id, happened_at, value_number, value_text, tags, objective_context, subjective_interpretation
`, d.HappenedAt, d.ValueNumber, d.ValueText, tagsJSON, d.ObjectiveContext, d.SubjectiveInterpretation, id).Scan(
		&outID, &outHappened, &outNum, &outText, &outTags, &outObj, &outSubj,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return Record{}, 404, ErrNotFound
		}
		return Record{}, 500, err
	}
	return FromDB(outID, outHappened, outNum, outText, outTags, outObj, outSubj), 200, nil
}
