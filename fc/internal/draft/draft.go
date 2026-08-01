package draft

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mdk/digitaltwin2026/fc/internal/jsonutil"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
	"github.com/mdk/digitaltwin2026/fc/internal/timeutil"
)

var isoTZSuffix = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)

// 十进制字面量：无科学计数、无前导 +、无前导零、须有整数部（与 Next DECIMAL_STRING 一致）
var decimalString = regexp.MustCompile(`^-?(?:0|[1-9]\d*)(?:\.\d+)?$`)

const (
	valueNumberMaxLen        = 40
	valueNumberMaxIntDigits  = 28
	valueNumberMaxFracDigits = 10
)

// ValueNumberMustBeString 在 JSON 以 number 传入 value_number 时返回（硬切断，不静默转 string）。
const ValueNumberMustBeString = "value_number must be a decimal string"

type RecordDraftBody struct {
	HappenedAt               any `json:"happened_at"`
	ValueNumber              any `json:"value_number"`
	ValueText                any `json:"value_text"`
	Tags                     any `json:"tags"`
	ObjectiveContext         any `json:"objective_context"`
	SubjectiveInterpretation any `json:"subjective_interpretation"`
}

type NormalizedRecordDraft struct {
	HappenedAt               time.Time
	ValueNumber              *string
	ValueText                *string
	Tags                     []string
	ObjectiveContext         string
	SubjectiveInterpretation *string
}

func EmptyStringToNull(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

// ParseHappenedAt 校验 ISO 8601 且必须带显式时区（与 Next parseHappenedAt / query from|to 一致）。
func ParseHappenedAt(raw string) (time.Time, error) {
	if raw == "" {
		return time.Time{}, fmt.Errorf("Missing required field: happened_at")
	}
	if !isoTZSuffix.MatchString(raw) {
		return time.Time{}, fmt.Errorf("happened_at must be ISO 8601 with timezone (Z or ±HH:MM)")
	}
	happenedAt, err := timeutil.ParseRFC3339Flexible(raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("Invalid happened_at datetime")
	}
	return happenedAt, nil
}

// ValidateDecimalString 校验已 trim 的十进制字面量（不经 float 往返；与 Next validateDecimalString 一致）。
// 长度用 utf8.RuneCountInString；Next 用 string.length。DECIMAL_STRING 仅 ASCII，合法字面量下相等（api-layering §1.1）。
// 边界样例见仓库根 testdata/decimal-string-cases.json（双端单测同读）。
func ValidateDecimalString(s string) error {
	if utf8.RuneCountInString(s) > valueNumberMaxLen || !decimalString.MatchString(s) {
		return fmt.Errorf("Invalid value_number")
	}
	unsigned := s
	if strings.HasPrefix(s, "-") {
		unsigned = s[1:]
	}
	intPart, fracPart, hasDot := strings.Cut(unsigned, ".")
	if len(intPart) > valueNumberMaxIntDigits {
		return fmt.Errorf("Invalid value_number")
	}
	if hasDot && len(fracPart) > valueNumberMaxFracDigits {
		return fmt.Errorf("Invalid value_number")
	}
	return nil
}

// ParseValueNumber：仅接受 string | null；JSON number / json.Number → 明确拒绝。
// trim 后空串 → null（PATCH/draft）；非空则校验并保留字面量。
func ParseValueNumber(raw any) (*string, error) {
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
		return nil, fmt.Errorf("%s", ValueNumberMustBeString)
	default:
		return nil, fmt.Errorf("Invalid value_number")
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

// ParseRecordDraft validates and normalizes an editable record snapshot.
func ParseRecordDraft(body RecordDraftBody) (*NormalizedRecordDraft, error) {
	happenedRaw, ok := body.HappenedAt.(string)
	if !ok {
		happenedRaw = ""
	}
	happenedAt, err := ParseHappenedAt(happenedRaw)
	if err != nil {
		return nil, err
	}

	valueNumber, err := ParseValueNumber(body.ValueNumber)
	if err != nil {
		return nil, err
	}

	var valueText *string
	if body.ValueText != nil {
		s, err := asStringPtr(body.ValueText)
		if err != nil {
			return nil, fmt.Errorf("Invalid value_text")
		}
		valueText = EmptyStringToNull(s)
	}

	if valueNumber == nil && valueText == nil {
		return nil, fmt.Errorf("value_number and value_text cannot both be null")
	}

	tagList, ok := body.Tags.([]any)
	if !ok {
		// also accept []string via JSON re-decode path
		if sl, ok2 := body.Tags.([]string); ok2 {
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

	objCtx, ok := body.ObjectiveContext.(string)
	if !ok || objCtx == "" {
		return nil, fmt.Errorf("Missing required field: objective_context")
	}

	var subjective *string
	if body.SubjectiveInterpretation != nil {
		s, err := asStringPtr(body.SubjectiveInterpretation)
		if err != nil {
			return nil, fmt.Errorf("Invalid subjective_interpretation")
		}
		subjective = EmptyStringToNull(s)
	}

	return &NormalizedRecordDraft{
		HappenedAt:               happenedAt,
		ValueNumber:              valueNumber,
		ValueText:                valueText,
		Tags:                     tagsStr,
		ObjectiveContext:         objCtx,
		SubjectiveInterpretation: subjective,
	}, nil
}

// ParseRecordDraftJSON unmarshals JSON with UseNumber and parses.
func ParseRecordDraftJSON(data []byte) (*NormalizedRecordDraft, error) {
	allowed := []string{
		"happened_at", "value_number", "value_text", "tags",
		"objective_context", "subjective_interpretation",
	}
	if err := jsonutil.RejectUnknownObjectKeys(data, allowed); err != nil {
		return nil, err
	}
	var raw map[string]any
	if err := jsonutil.DecodeUseNumber(data, &raw); err != nil {
		return nil, err
	}
	body := RecordDraftBody{
		HappenedAt:               raw["happened_at"],
		ValueNumber:              raw["value_number"],
		ValueText:                raw["value_text"],
		Tags:                     raw["tags"],
		ObjectiveContext:         raw["objective_context"],
		SubjectiveInterpretation: raw["subjective_interpretation"],
	}
	return ParseRecordDraft(body)
}
