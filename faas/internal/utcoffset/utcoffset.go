// Package utcoffset：隐列 utc_offset 字面量拆分 / 规范化与按隐列格式化瞬间。
// 与 Next src/lib/utcoffset.ts 对齐；规范见 docs/20260803-utc-offset.md §3。
package utcoffset

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

// 与 draft / query 一致：Z / ±HH:MM / ±HHMM
var isoTZSuffix = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)

var canonicalOffset = regexp.MustCompile(`^[+-]\d{2}:\d{2}$`)

const missingTZ = "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"

// ExtractUtcOffsetLiteral 从带区 ISO 末尾拆出时区后缀并规范成入库形：Z 或 ±HH:MM。
// Z/z → Z；+0800 → +08:00；不把 Z 与 +00:00 互相折叠。
func ExtractUtcOffsetLiteral(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("%s", missingTZ)
	}
	loc := isoTZSuffix.FindStringIndex(raw)
	if loc == nil {
		return "", fmt.Errorf("%s", missingTZ)
	}
	suffix := raw[loc[0]:loc[1]]
	return NormalizeUtcOffsetSuffix(suffix), nil
}

// NormalizeUtcOffsetSuffix 将已匹配的后缀规范成 Z 或 ±HH:MM。
func NormalizeUtcOffsetSuffix(suffix string) string {
	if suffix == "Z" || suffix == "z" {
		return "Z"
	}
	if len(suffix) == 5 && suffix[3] != ':' {
		// ±HHMM
		return suffix[:3] + ":" + suffix[3:]
	}
	return suffix
}

// FormatHappenedAt 瞬间 + 隐列 utc_offset → 带区 ISO（毫秒三位）。
// Z → …Z；+00:00 → …+00:00（不折叠）。
func FormatHappenedAt(instant time.Time, utcOffset string) (string, error) {
	if utcOffset == "Z" {
		return instant.UTC().Format("2006-01-02T15:04:05.000Z"), nil
	}
	if !canonicalOffset.MatchString(utcOffset) {
		return "", fmt.Errorf("Invalid utc_offset: %s", utcOffset)
	}
	sign := 1
	if utcOffset[0] == '-' {
		sign = -1
	}
	hours, err := strconv.Atoi(utcOffset[1:3])
	if err != nil {
		return "", fmt.Errorf("Invalid utc_offset: %s", utcOffset)
	}
	minutes, err := strconv.Atoi(utcOffset[4:6])
	if err != nil {
		return "", fmt.Errorf("Invalid utc_offset: %s", utcOffset)
	}
	secondsEast := sign * (hours*3600 + minutes*60)
	// FixedZone 名为空时 Format 仍用数字 offset；用字面量作名便于调试。
	loc := time.FixedZone(utcOffset, secondsEast)
	local := instant.In(loc)
	// 固定用隐列字面量作后缀，避免 -00:00 被某些布局折叠。
	return local.Format("2006-01-02T15:04:05.000") + utcOffset, nil
}
