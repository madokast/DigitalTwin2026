package record

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mdk/digitaltwin2026/faas/internal/db"
	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/utcoffset"
)

// Record matches Next JSON shape（snake_case HTTP JSON）。
type Record struct {
	ID                       string   `json:"id"`
	HappenedAt               string   `json:"happened_at"`
	NumericValue              *string  `json:"numeric_value,omitempty"`
	RawContent                *string  `json:"raw_content"`
	Tags                     []string `json:"tags"`
	ObjectiveContext         string   `json:"objective_context"`
	SubjectiveInterpretation *string  `json:"subjective_interpretation"`
}

// ParseTagsField DB text 列 → tags 数组；chk_tags 保证非空 JSON 数组形，
// parse 失败或元素非 string 时过滤（与 TS parseTagsField 对齐）。
func ParseTagsField(tags string) []string {
	var parsed any
	if err := json.Unmarshal([]byte(tags), &parsed); err != nil {
		return []string{}
	}
	arr, ok := parsed.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// FormatHappenedAt 一律 UTC Z（无 offset）。**仅**作隐列损坏时 FromDB / SerializeLine 回退；
// 生产读路径必须用 FromDB / utcoffset.FormatHappenedAt(instant, utcOffset)。
func FormatHappenedAt(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func FromDB(
	id string,
	happenedAt time.Time,
	utcOffset string,
	numericValue *string,
	rawContent *string,
	tags string,
	objectiveContext string,
	subjectiveInterpretation *string,
) Record {
	formatted, err := utcoffset.FormatHappenedAt(happenedAt, utcOffset)
	if err != nil {
		// 隐列损坏时仍可序列化；正常路径有 DB CHECK + 写入校验
		formatted = FormatHappenedAt(happenedAt)
	}
	return Record{
		ID:                       id,
		HappenedAt:               formatted,
		NumericValue:              numericValue,
		RawContent:                rawContent,
		Tags:                     ParseTagsField(tags),
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

// 与 npm `uuid` validate 所用正则一致（version [1-8]、variant [89ab]，另允 nil / max UUID）。
// 不用 google/uuid.Parse：它会接受非法 version/variant，导致与 Next 400 分歧。
var uuidValidateRE = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

// IsValidID 与 Next isValidRecordId（uuid.validate）对齐。
func IsValidID(id string) bool {
	return uuidValidateRE.MatchString(id)
}

// Update 按已归一化草稿更新一条记录；成功 (rec, 200, nil)；不存在 (空, 404, err)。
// 带 HappenedAt → 重算写入 utc_offset；省略 → 两列都不动（§7）。
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
		outID, outTags, outObj, outOffset string
		outHappened                       time.Time
		outNum, outText, outSubj          *string
	)

	if d.HappenedAt != nil && d.UtcOffset != nil {
		err = q.QueryRow(ctx, `
UPDATE records SET
  happened_at = $1,
  utc_offset = $2,
  numeric_value = $3,
  raw_content = $4,
  tags = $5,
  objective_context = $6,
  subjective_interpretation = $7
WHERE id = $8
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, subjective_interpretation
`, *d.HappenedAt, *d.UtcOffset, d.NumericValue, d.RawContent, tagsJSON, d.ObjectiveContext, d.SubjectiveInterpretation, id).Scan(
			&outID, &outHappened, &outOffset, &outNum, &outText, &outTags, &outObj, &outSubj,
		)
	} else {
		err = q.QueryRow(ctx, `
UPDATE records SET
  numeric_value = $1,
  raw_content = $2,
  tags = $3,
  objective_context = $4,
  subjective_interpretation = $5
WHERE id = $6
RETURNING id, happened_at, utc_offset, numeric_value, raw_content, tags, objective_context, subjective_interpretation
`, d.NumericValue, d.RawContent, tagsJSON, d.ObjectiveContext, d.SubjectiveInterpretation, id).Scan(
			&outID, &outHappened, &outOffset, &outNum, &outText, &outTags, &outObj, &outSubj,
		)
	}
	if err != nil {
		if err == pgx.ErrNoRows {
			return Record{}, 404, ErrNotFound
		}
		return Record{}, 500, err
	}
	return FromDB(outID, outHappened, outOffset, outNum, outText, outTags, outObj, outSubj), 200, nil
}
