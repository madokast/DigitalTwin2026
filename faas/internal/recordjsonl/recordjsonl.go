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
	"github.com/mdk/digitaltwin2026/faas/internal/utcoffset"
)

// RECORD JSONL 行编解码 / 校验（与 Next src/lib/recordjsonl.ts 同构）。
//
// 表示层 = OpenAPI Record snake_case；禁止 Todo deform 键（created_at / content）。
// 语义对齐 draft（时间 / 小数 / 双 null / tags 格式）。tags 在文件中为 JSON **数组**
// （与 JSON API 一致）；ParseLine 兼容旧备份的字符串化 JSON 数组。
//
// 不调用 tags.AssertNoReservedTags：import 须可写保留 tag；若调用方需拒绝保留 tag，
// 自行在 ParseLine 成功后调用 AssertNoReservedTags(row.Tags)。

// RecordJSONLKeys OpenAPI Record 键（snake_case）。
var RecordJSONLKeys = []string{
	"id",
	"happened_at",
	"numeric_value",
	"raw_content",
	"tags",
	"objective_context",
	"ai_analysis",
}

// InvalidJSONLine 非法 JSON 行（与 HTTP Invalid JSON body 区分）。
const InvalidJSONLine = "Invalid JSON line"

// InvalidTags tags 类型非法（既非字符串化 JSON 数组，也非 JSON 数组）。
const InvalidTags = "Invalid tags"

// InvalidTagsJSON tags 字符串无法 JSON.parse。
const InvalidTagsJSON = "Invalid tags JSON"

const utf8BOM = "\ufeff"

// Row 领域行：ParseLine 产出；SerializeLine 输入。
type Row struct {
	ID                       string
	HappenedAt               time.Time
	UtcOffset                string
	NumericValue              *string
	RawContent                *string
	Tags                     []string
	ObjectiveContext         string
	AiAnalysis *string
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

	// 除 numeric_value 外全部 required：numeric_value 可省略（= null；双 null 校验在下方）
	for _, key := range RecordJSONLKeys {
		if key == "numeric_value" {
			continue
		}
		if _, ok := m[key]; !ok {
			return nil, wrapErr("Missing required field: "+key, lineNumber)
		}
	}

	id, ok := m["id"].(string)
	if !ok || id == "" || !record.IsValidID(id) {
		return nil, wrapErr(record.ErrInvalidID.Error(), lineNumber)
	}

	happenedRaw, _ := m["happened_at"].(string)
	happenedAt, utcOffset, err := draft.ParseHappenedAt(happenedRaw)
	if err != nil {
		return nil, wrapErr(err.Error(), lineNumber)
	}

	numericValue, err := draft.ParseNumericValue(m["numeric_value"])
	if err != nil {
		return nil, wrapErr(err.Error(), lineNumber)
	}

	var rawContent *string
	if m["raw_content"] != nil {
		s, ok := m["raw_content"].(string)
		if !ok {
			return nil, wrapErr("Invalid raw_content", lineNumber)
		}
		t, err := draft.RequireTrimmedText(s, "raw_content")
		if err != nil {
			return nil, wrapErr(err.Error(), lineNumber)
		}
		rawContent = &t
	}

	if numericValue == nil && rawContent == nil {
		return nil, wrapErr("numeric_value and raw_content cannot both be null", lineNumber)
	}

	// tags 双兼容：字符串化 JSON 数组（旧备份）或 JSON 数组（新格式）
	var tagsRaw any = m["tags"]
	if tagsStr, ok := tagsRaw.(string); ok {
		if err := json.Unmarshal([]byte(tagsStr), &tagsRaw); err != nil {
			return nil, wrapErr(InvalidTagsJSON, lineNumber)
		}
	}
	tagList, ok := tagsRaw.([]any)
	if !ok {
		return nil, wrapErr(InvalidTags, lineNumber)
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

	objCtx, err := draft.RequireTrimmedText(m["objective_context"], "objective_context")
	if err != nil {
		return nil, wrapErr(err.Error(), lineNumber)
	}

	aiAnalysis, err := draft.OptionalTrimmedNullable(m["ai_analysis"], "ai_analysis")
	if err != nil {
		return nil, wrapErr(err.Error(), lineNumber)
	}

	return &Row{
		ID:                       id,
		HappenedAt:               happenedAt,
		UtcOffset:                utcOffset,
		NumericValue:              numericValue,
		RawContent:                rawContent,
		Tags:                     tagsOut,
		ObjectiveContext:         objCtx,
		AiAnalysis: aiAnalysis,
	}, nil
}

// SerializeLine 领域行 → 一行 JSONL（无尾换行；happened_at 按 utc_offset 带区；tags 数组）。
// 键序固定，与 Next serializeLine 一致。
func SerializeLine(row *Row) (string, error) {
	happenedAt, err := utcoffset.FormatHappenedAt(row.HappenedAt, row.UtcOffset)
	if err != nil {
		// 隐列损坏时仍可序列化；正常路径有写入校验
		happenedAt = record.FormatHappenedAt(row.HappenedAt)
	}
	rec := record.Record{
		ID:                       row.ID,
		HappenedAt:               happenedAt,
		NumericValue:              row.NumericValue,
		RawContent:                row.RawContent,
		Tags:                     row.Tags,
		ObjectiveContext:         row.ObjectiveContext,
		AiAnalysis: row.AiAnalysis,
	}
	return SerializeRecord(rec)
}

// SerializeRecord 已是 API Record 形状时直接序列化（导出路径）。
func SerializeRecord(rec record.Record) (string, error) {
	// 用手写 map 保键序（encoding/json 对 struct 按字段声明序，与 Next 对象字面量一致）
	b, err := json.Marshal(orderedRecord{
		ID:                       rec.ID,
		HappenedAt:               rec.HappenedAt,
		NumericValue:              rec.NumericValue,
		RawContent:                rec.RawContent,
		Tags:                     rec.Tags,
		ObjectiveContext:         rec.ObjectiveContext,
		AiAnalysis: rec.AiAnalysis,
	})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// orderedRecord 字段声明序 = JSONL 键序。
type orderedRecord struct {
	ID                       string   `json:"id"`
	HappenedAt               string   `json:"happened_at"`
	NumericValue              *string  `json:"numeric_value,omitempty"`
	RawContent                *string  `json:"raw_content"`
	Tags                     []string `json:"tags"`
	ObjectiveContext         string   `json:"objective_context"`
	AiAnalysis *string  `json:"ai_analysis"`
}
