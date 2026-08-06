package draft

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

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

// ErrNumericValueMustBeString 在 JSON 以 number 传入 numeric_value 时返回（硬切断，不静默转 string）。
var ErrNumericValueMustBeString = errors.New("numeric_value must be a decimal string")

// ValidateHappenedAt 业务层校验 happened_at（零 DB，校验失败 → 400）：
// 只校验不产 time/offset，构造 record.Record（HappenedAt = 已校验请求串）后由
// Repository 内 ParseHappenedAt 落库时再次解析（接受两次解析成本，换取单一 Record 形态）。
func ValidateHappenedAt(raw string) error {
	_, _, err := ParseHappenedAt(raw)
	return err
}

// ParseHappenedAt 校验 ISO 8601 且必须带显式时区（与 Next parseHappenedAt / query from|to 一致）。
// 同时返回规范 utc_offset（创建路径写隐列）。
func ParseHappenedAt(raw string) (time.Time, string, error) {
	if raw == "" {
		return time.Time{}, "", fmt.Errorf("missing required field: happened_at")
	}
	if !isoTZSuffix.MatchString(raw) {
		return time.Time{}, "", fmt.Errorf("happened_at must be ISO 8601 with timezone (Z or ±HH:MM)")
	}
	happenedAt, err := timeutil.ParseRFC3339Flexible(raw)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("invalid happened_at datetime")
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
		return fmt.Errorf("invalid numeric_value")
	}
	unsigned := s
	if strings.HasPrefix(s, "-") {
		unsigned = s[1:]
	}
	intPart, fracPart, hasDot := strings.Cut(unsigned, ".")
	if len(intPart) > numericValueMaxIntDigits {
		return fmt.Errorf("invalid numeric_value")
	}
	if hasDot && len(fracPart) > numericValueMaxFracDigits {
		return fmt.Errorf("invalid numeric_value")
	}
	return nil
}

// ParseNumericValue：仅接受 string | null；JSON number / json.Number → 明确拒绝。
// trim 后空串 → null；非空则校验并保留字面量。
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
		return nil, fmt.Errorf("%w", ErrNumericValueMustBeString)
	default:
		return nil, fmt.Errorf("invalid numeric_value")
	}
}

// RequireTrimmedText 必填文本：缺失 / 空串 / 非 string → Missing；空白串 → must not be blank；存 trim 后值。
func RequireTrimmedText(raw any, field string) (string, error) {
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("missing required field: %s", field)
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
		return nil, fmt.Errorf("invalid %s", field)
	}
	if strings.TrimSpace(s) == "" {
		return nil, fmt.Errorf("%s must not be blank", field)
	}
	t := strings.TrimSpace(s)
	return &t, nil
}
