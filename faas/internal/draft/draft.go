package draft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/timeutil"
	"github.com/mdk/digitaltwin2026/faas/internal/utcoffset"
)

var isoTZSuffix = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)

// 十进制字面量：无科学计数、无前导 +、无前导零、须有整数部（与 Next DECIMAL_STRING 一致）
var decimalString = regexp.MustCompile(`^-?(?:0|[1-9]\d*)(?:\.\d+)?$`)

const (
	numericValueMaxLen        = 40
	numericValueMaxIntDigits  = 28
	numericValueMaxFracDigits = 10
)

// NumericValueMustBeString 在 JSON 以 number 传入 numeric_value 时返回（硬切断，不静默转 string）。
const NumericValueMustBeString = "numeric_value must be a decimal string"

type RecordDraftBody struct {
	HappenedAt               any `json:"happened_at"`
	NumericValue              any `json:"numeric_value"`
	RawContent                any `json:"raw_content"`
	Tags                     any `json:"tags"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
}

type NormalizedRecordDraft struct {
	// HappenedAt / UtcOffset：请求带 happened_at 时非 nil（一并写入）；省略则为 nil（§7 两列都不动）。
	HappenedAt               *time.Time
	UtcOffset                *string
	NumericValue              *string
	RawContent                *string
	Tags                     []string
	ObjectiveContext         string
	SubjectiveInterpretation *string
}

// ParseHappenedAt 校验 ISO 8601 且必须带显式时区（与 Next parseHappenedAt / query from|to 一致）。
// 同时返回规范 utc_offset（创建路径写隐列；PATCH 见 ParseRecordDraft / Update §7）。
func ParseHappenedAt(raw string) (time.Time, string, error) {
	if raw == "" {
		return time.Time{}, "", fmt.Errorf("Missing required field: happened_at")
	}
	if !isoTZSuffix.MatchString(raw) {
		return time.Time{}, "", fmt.Errorf("happened_at must be ISO 8601 with timezone (Z or ±HH:MM)")
	}
	happenedAt, err := timeutil.ParseRFC3339Flexible(raw)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("Invalid happened_at datetime")
	}
	offset, err := utcoffset.ExtractUtcOffsetLiteral(raw)
	if err != nil {
		return time.Time{}, "", err
	}
	return happenedAt, offset, nil
}

// ValidateDecimalString 校验已 trim 的十进制字面量（不经 float 往返；与 Next validateDecimalString 一致）。
// 长度用 utf8.RuneCountInString；Next 用 string.length。DECIMAL_STRING 仅 ASCII，合法字面量下相等（api-layering §1.1）。
// 边界样例见仓库根 testdata/decimal-string-cases.json（双端单测同读）。
func ValidateDecimalString(s string) error {
	if utf8.RuneCountInString(s) > numericValueMaxLen || !decimalString.MatchString(s) {
		return fmt.Errorf("Invalid numeric_value")
	}
	unsigned := s
	if strings.HasPrefix(s, "-") {
		unsigned = s[1:]
	}
	intPart, fracPart, hasDot := strings.Cut(unsigned, ".")
	if len(intPart) > numericValueMaxIntDigits {
		return fmt.Errorf("Invalid numeric_value")
	}
	if hasDot && len(fracPart) > numericValueMaxFracDigits {
		return fmt.Errorf("Invalid numeric_value")
	}
	return nil
}

// ParseNumericValue：仅接受 string | null；JSON number / json.Number → 明确拒绝。
// trim 后空串 → null（PATCH/draft）；非空则校验并保留字面量。
func ParseNumericValue(raw any) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	switch v := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return nil, nil
		}
		if err := ValidateDecimalString(trimmed); err != nil {
			return nil, err
		}
		return &trimmed, nil
	case float64, json.Number:
		return nil, fmt.Errorf("%s", NumericValueMustBeString)
	default:
		return nil, fmt.Errorf("Invalid numeric_value")
	}
}

func asStringPtr(raw any) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("not a string")
	}
	return &s, nil
}

// ParseRecordDraft validates and normalizes an editable record snapshot（Admin PATCH）。
// body.HappenedAt == nil → 省略时间键（§7）；非 nil 则解析瞬间并抽出 utc_offset。
func ParseRecordDraft(body RecordDraftBody) (*NormalizedRecordDraft, error) {
	return parseRecordDraft(body, body.HappenedAt != nil)
}

// RequireTrimmedText 必填文本：缺失 / 空串 / 非 string → Missing；空白串 → must not be blank；存 trim 后值。
func RequireTrimmedText(raw any, field string) (string, error) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("Missing required field: %s", field)
	}
	if strings.TrimSpace(s) == "" {
		return "", fmt.Errorf("%s must not be blank", field)
	}
	return strings.TrimSpace(s), nil
}

// OptionalTrimmedNullable 可空文本：nil → nil；非 string → Invalid；空串 / 空白串 → must not be blank；存 trim 后值。
func OptionalTrimmedNullable(raw any, field string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	s, ok := raw.(string)
	if !ok {
		return nil, fmt.Errorf("Invalid %s", field)
	}
	if strings.TrimSpace(s) == "" {
		return nil, fmt.Errorf("%s must not be blank", field)
	}
	t := strings.TrimSpace(s)
	return &t, nil
}

func parseRecordDraft(body RecordDraftBody, hasHappenedAt bool) (*NormalizedRecordDraft, error) {
	var happenedAt *time.Time
	var utcOffset *string
	if hasHappenedAt {
		happenedRaw, ok := body.HappenedAt.(string)
		if !ok {
			happenedRaw = ""
		}
		t, offset, err := ParseHappenedAt(happenedRaw)
		if err != nil {
			return nil, err
		}
		happenedAt = &t
		utcOffset = &offset
	}

	numericValue, err := ParseNumericValue(body.NumericValue)
	if err != nil {
		return nil, err
	}

	var rawContent *string
	if body.RawContent != nil {
		s, err := asStringPtr(body.RawContent)
		if err != nil {
			return nil, fmt.Errorf("Invalid raw_content")
		}
		t, err := RequireTrimmedText(*s, "raw_content")
		if err != nil {
			return nil, err
		}
		rawContent = &t
	}

	if numericValue == nil && rawContent == nil {
		return nil, fmt.Errorf("numeric_value and raw_content cannot both be null")
	}

	var tagList []any
	if body.Tags != nil {
		var ok bool
		tagList, ok = body.Tags.([]any)
		if !ok {
			// also accept []string via JSON re-decode path
			if sl, ok2 := body.Tags.([]string); ok2 {
				tagList = make([]any, len(sl))
				for i, t := range sl {
					tagList[i] = t
				}
			} else {
				return nil, fmt.Errorf("tags must be an array of strings")
			}
		}
	}
	tagsStr := make([]string, 0, len(tagList))
	for _, item := range tagList {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("tags must be an array of strings")
		}
		tagsStr = append(tagsStr, s)
	}
	tv := tags.ValidateTags(tagsStr)
	if !tv.Valid {
		return nil, fmt.Errorf("%s", tv.Error)
	}
	if rv := tags.AssertNoReservedTags(tagsStr); !rv.Valid {
		return nil, fmt.Errorf("%s", rv.Error)
	}

	objCtx, err := RequireTrimmedText(body.ObjectiveContext, "objective_context")
	if err != nil {
		return nil, err
	}

	subjective, err := OptionalTrimmedNullable(body.SubjectiveInterpretation, "subjective_interpretation")
	if err != nil {
		return nil, err
	}

	return &NormalizedRecordDraft{
		HappenedAt:               happenedAt,
		UtcOffset:                utcOffset,
		NumericValue:              numericValue,
		RawContent:                rawContent,
		Tags:                     tagsStr,
		ObjectiveContext:         objCtx,
		SubjectiveInterpretation: subjective,
	}, nil
}

// ParseRecordDraftJSON unmarshals JSON with UseNumber and parses.
// happened_at 键缺席 → 省略；键在但值为 null/非 string → 走 ParseHappenedAt 校验。
func ParseRecordDraftJSON(data []byte) (*NormalizedRecordDraft, error) {
	allowed := []string{
		"happened_at", "numeric_value", "raw_content", "tags",
		"objective_context", "subjective_interpretation",
	}
	if err := jsonutil.RejectUnknownObjectKeys(data, allowed); err != nil {
		return nil, err
	}
	var raw map[string]any
	if err := jsonutil.DecodeUseNumber(data, &raw); err != nil {
		return nil, err
	}
	_, hasHappenedAt := raw["happened_at"]
	body := RecordDraftBody{
		HappenedAt:               raw["happened_at"],
		NumericValue:              raw["numeric_value"],
		RawContent:                raw["raw_content"],
		Tags:                     raw["tags"],
		ObjectiveContext:         raw["objective_context"],
		SubjectiveInterpretation: raw["subjective_interpretation"],
	}
	return parseRecordDraft(body, hasHappenedAt)
}
