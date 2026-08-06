package record

import (
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/utcoffset"
)

// Record matches Next JSON shape（snake_case HTTP JSON）。
type Record struct {
	ID               string   `json:"id"`
	HappenedAt       string   `json:"happened_at"`
	UtcOffset        string   `json:"-"` // 隐列（对外 JSON 不可见）；FromDB 填充，Repository 写入用
	NumericValue     *string  `json:"numeric_value,omitempty"`
	RawContent       *string  `json:"raw_content"`
	ObjectiveContext string   `json:"objective_context"`
	AiAnalysis       *string  `json:"ai_analysis"`
	Tags             []string `json:"tags"`
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
	aiAnalysis *string,
) Record {
	formatted, err := utcoffset.FormatHappenedAt(happenedAt, utcOffset)
	if err != nil {
		// 隐列损坏时仍可序列化；正常路径有 DB CHECK + 写入校验
		formatted = FormatHappenedAt(happenedAt)
	}
	return Record{
		ID:                       id,
		HappenedAt:               formatted,
		UtcOffset:                utcOffset,
		NumericValue:              numericValue,
		RawContent:                rawContent,
		Tags:                     ParseTagsField(tags),
		ObjectiveContext:         objectiveContext,
		AiAnalysis: aiAnalysis,
	}
}

func TagsJSON(tags []string) (string, error) {
	b, err := json.Marshal(tags)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ErrInvalidID 与 TS INVALID_RECORD_ID 同文案：非 UUID → 400，避免 PG 类型错误变 500。
var ErrInvalidID = errors.New("invalid record id")

// 与 npm `uuid` validate 所用正则一致（version [1-8]、variant [89ab]，另允 nil / max UUID）。
// 不用 google/uuid.Parse：它会接受非法 version/variant，导致与 Next 400 分歧。
var uuidValidateRE = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

// IsValidID 与 Next isValidRecordId（uuid.validate）对齐。
func IsValidID(id string) bool {
	return uuidValidateRE.MatchString(id)
}
