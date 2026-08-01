package timeutil

import (
	"fmt"
	"regexp"
	"time"

	// 嵌入 IANA tzdata：FC 精简运行时若无系统 zoneinfo，LoadLocation("Asia/Shanghai") 仍可用。
	// 与 Next Intl 行为对齐，避免 summary?tz= 在国内镜像上误 400。
	_ "time/tzdata"
)

// compactOffsetSuffix 匹配末尾 ±HHMM（无冒号）；RFC3339 要求 ±HH:MM。
var compactOffsetSuffix = regexp.MustCompile(`([+-]\d{2})(\d{2})$`)

// ExpandCompactOffset 将 ISO 8601 末尾 ±HHMM 扩成 ±HH:MM，便于 time.Parse(RFC3339*)。
// 已是 Z / ±HH:MM 则原样返回。与 Next `new Date` / OpenAPI HappenedAtInput 对齐。
func ExpandCompactOffset(s string) string {
	if len(s) >= 1 && (s[len(s)-1] == 'Z' || s[len(s)-1] == 'z') {
		return s
	}
	if len(s) >= 6 && s[len(s)-3] == ':' {
		return s
	}
	return compactOffsetSuffix.ReplaceAllString(s, "$1:$2")
}

// ParseRFC3339Flexible 解析带显式时区的 ISO 8601（含 ±HHMM）。
func ParseRFC3339Flexible(raw string) (time.Time, error) {
	normalized := ExpandCompactOffset(raw)
	t, err := time.Parse(time.RFC3339Nano, normalized)
	if err != nil {
		t, err = time.Parse(time.RFC3339, normalized)
		if err != nil {
			return time.Time{}, err
		}
	}
	return t, nil
}

func IsValidTimeZone(tz string) bool {
	if tz == "" {
		return false
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

// GetZonedDayBounds returns half-open [start, end) for the calendar day of now in tz.
func GetZonedDayBounds(now time.Time, tz string) (start, end time.Time, err error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("Invalid time zone: %s", tz)
	}
	local := now.In(loc)
	y, m, d := local.Date()
	return CalendarDayBounds(y, int(m), d, tz)
}

// CalendarDayBounds returns [start, end) for the wall-clock calendar day in tz.
func CalendarDayBounds(year, month, day int, tz string) (start, end time.Time, err error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("Invalid time zone: %s", tz)
	}
	start = time.Date(year, time.Month(month), day, 0, 0, 0, 0, loc)
	end = start.AddDate(0, 0, 1)
	return start, end, nil
}
