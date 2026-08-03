package recordjsonl

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

// RECORD JSONL 行编解码 / 校验（与 Next src/lib/recordjsonl.ts 同构）。
//
// 表示层 = OpenAPI Record snake_case；禁止 Todo deform 键（created_at / content）。
// 语义对齐 draft（时间 / 小数 / 双 null / tags 格式），但 tags 在文件中为字符串化 JSON 数组。
//
// 不调用 tags.AssertNoReservedTags：import 须可写保留 tag；若调用方需拒绝保留 tag，
// 自行在 ParseLine 成功后调用 AssertNoReservedTags(row.Tags)。

// RecordJSONLKeys OpenAPI Record 键（snake_case）。
var RecordJSONLKeys = []string{
	"id",
	"happened_at",
	"value_number",
	"value_text",
	"tags",
	"objective_context",
	"subjective_interpretation",
}

// InvalidJSONLine 非法 JSON 行（与 HTTP Invalid JSON body 区分）。
const InvalidJSONLine = "Invalid JSON line"

// TagsMustBeStringifiedArray tags 误传 JSON 数组类型（Record 要求 string）。
const TagsMustBeStringifiedArray = "tags must be a stringified JSON array"

// InvalidTagsJSON tags 字符串无法 JSON.parse。
const InvalidTagsJSON = "Invalid tags JSON"

const utf8BOM = "\ufeff"

// Row 领域行：ParseLine 产出；SerializeLine 输入。
type Row struct {
	ID                       string
	HappenedAt               time.Time
	ValueNumber              *string
	ValueText                *string
	Tags                     []string
	ObjectiveContext         string
	SubjectiveInterpretation *string
}

// FormatLineError 可选行号包装：`line N: …`（1-based）。lineNumber < 1 时原样返回。
func FormatLineError(message string, lineNumber int) string {
	if lineNumber >= 1 {
		return fmt.Sprintf("line %d: %s", lineNumber, message)
	}
	return message
}

func wrapErr(message string, lineNumber int) error {
	return fmt.Errorf("%s", FormatLineError(message, lineNumber))
}

// ParseLine 解析一行 JSONL（可含前导 BOM；首尾空白 trim）。
// lineNumber：传 >=1 时错误带 `line N: ` 前缀；传 0 表示不带行号。
func ParseLine(rawLine string, lineNumber int) (*Row, error) {
	line := rawLine
	if strings.HasPrefix(line, utf8BOM) {
		line = strings.TrimPrefix(line, utf8BOM)
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, wrapErr(InvalidJSONLine, lineNumber)
	}

	raw := []byte(line)
	if err := jsonutil.RejectUnknownObjectKeys(raw, RecordJSONLKeys); err != nil {
		msg := err.Error()
		if msg == jsonutil.ErrInvalidJSONBody.Error() {
			msg = InvalidJSONLine
		}
		return nil, wrapErr(msg, lineNumber)
	}

	var m map[string]any
	if err := jsonutil.DecodeUseNumber(raw, &m); err != nil {
		return nil, wrapErr(InvalidJSONLine, lineNumber)
	}

	for _, key := range RecordJSONLKeys {
		if _, ok := m[key]; !ok {
			return nil, wrapErr("Missing required field: "+key, lineNumber)
		}
	}

	id, ok := m["id"].(string)
	if !ok || id == "" || !record.IsValidID(id) {
		return nil, wrapErr(record.InvalidID.Error(), lineNumber)
	}

	happenedRaw, _ := m["happened_at"].(string)
	happenedAt, err := draft.ParseHappenedAt(happenedRaw)
	if err != nil {
		return nil, wrapErr(err.Error(), lineNumber)
	}

	valueNumber, err := draft.ParseValueNumber(m["value_number"])
	if err != nil {
		return nil, wrapErr(err.Error(), lineNumber)
	}

	var valueText *string
	if m["value_text"] != nil {
		s, ok := m["value_text"].(string)
		if !ok {
			return nil, wrapErr("Invalid value_text", lineNumber)
		}
		valueText = draft.EmptyStringToNull(&s)
	}

	if valueNumber == nil && valueText == nil {
		return nil, wrapErr("value_number and value_text cannot both be null", lineNumber)
	}

	switch m["tags"].(type) {
	case []any, []string:
		return nil, wrapErr(TagsMustBeStringifiedArray, lineNumber)
	}
	tagsStr, ok := m["tags"].(string)
	if !ok {
		return nil, wrapErr(TagsMustBeStringifiedArray, lineNumber)
	}

	var tagsParsed any
	if err := json.Unmarshal([]byte(tagsStr), &tagsParsed); err != nil {
		return nil, wrapErr(InvalidTagsJSON, lineNumber)
	}
	tagList, ok := tagsParsed.([]any)
	if !ok {
		return nil, wrapErr(tags.ErrTagsNotJSONArray.Error(), lineNumber)
	}
	tagsOut := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, wrapErr("tags must be an array of strings", lineNumber)
		}
		tagsOut = append(tagsOut, s)
	}
	tv := tags.ValidateTags(tagsOut)
	if !tv.Valid {
		return nil, wrapErr(tv.Error, lineNumber)
	}
	// 故意不调用 AssertNoReservedTags（见包注释）

	objCtx, ok := m["objective_context"].(string)
	if !ok || objCtx == "" {
		return nil, wrapErr("Missing required field: objective_context", lineNumber)
	}

	var subjective *string
	if m["subjective_interpretation"] != nil {
		s, ok := m["subjective_interpretation"].(string)
		if !ok {
			return nil, wrapErr("Invalid subjective_interpretation", lineNumber)
		}
		subjective = draft.EmptyStringToNull(&s)
	}

	return &Row{
		ID:                       id,
		HappenedAt:               happenedAt,
		ValueNumber:              valueNumber,
		ValueText:                valueText,
		Tags:                     tagsOut,
		ObjectiveContext:         objCtx,
		SubjectiveInterpretation: subjective,
	}, nil
}

// SerializeLine 领域行 → 一行 JSONL（无尾换行；happened_at UTC Z；tags 字符串化）。
// 键序固定，与 Next serializeLine 一致。
func SerializeLine(row *Row) (string, error) {
	tagsJSON, err := record.TagsJSON(row.Tags)
	if err != nil {
		return "", err
	}
	rec := record.Record{
		ID:                       row.ID,
		HappenedAt:               record.FormatHappenedAt(row.HappenedAt),
		ValueNumber:              row.ValueNumber,
		ValueText:                row.ValueText,
		Tags:                     tagsJSON,
		ObjectiveContext:         row.ObjectiveContext,
		SubjectiveInterpretation: row.SubjectiveInterpretation,
	}
	return SerializeRecord(rec)
}

// SerializeRecord 已是 API Record 形状时直接序列化（导出路径）。
func SerializeRecord(rec record.Record) (string, error) {
	// 用手写 map 保键序（encoding/json 对 struct 按字段声明序，与 Next 对象字面量一致）
	b, err := json.Marshal(orderedRecord{
		ID:                       rec.ID,
		HappenedAt:               rec.HappenedAt,
		ValueNumber:              rec.ValueNumber,
		ValueText:                rec.ValueText,
		Tags:                     rec.Tags,
		ObjectiveContext:         rec.ObjectiveContext,
		SubjectiveInterpretation: rec.SubjectiveInterpretation,
	})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// orderedRecord 字段声明序 = JSONL 键序。
type orderedRecord struct {
	ID                       string  `json:"id"`
	HappenedAt               string  `json:"happened_at"`
	ValueNumber              *string `json:"value_number"`
	ValueText                *string `json:"value_text"`
	Tags                     string  `json:"tags"`
	ObjectiveContext         string  `json:"objective_context"`
	SubjectiveInterpretation *string `json:"subjective_interpretation"`
}
