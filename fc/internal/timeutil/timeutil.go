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

// rfc3339Strict 为 expand 之后的形态（须大写 Z、T 分隔、各字段补零），
// 与 OpenAPI HappenedAtInput / Next parseRFC3339Flexible 对齐；
// 比裸 time.Parse(RFC3339) 更严（后者会收下单数字小时等）。
var rfc3339Strict = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)

// ExpandCompactOffset 将 ISO 8601 末尾 ±HHMM 扩成 ±HH:MM，便于 time.Parse(RFC3339*)。
// 已是 Z / ±HH:MM 则原样返回。与 Next expandCompactOffset / OpenAPI HappenedAtInput 对齐。
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
	if !rfc3339Strict.MatchString(normalized) {
		return time.Time{}, fmt.Errorf("invalid RFC3339 datetime")
	}
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
	// Go time/tzdata 会 LoadLocation 成功、但非 Intl IANA 名的特殊条目；
	// 与 Next isValidTimeZone（Intl）求交，避免 summary?tz= 一端 200 一端 400。
	switch tz {
	case "Factory", "localtime", "posixrules":
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
// end = start.AddDate(0, 0, 1)（与 Next calendarDayBounds 墙钟日+1 对齐；DST 23h/25h 日由 tzdata 处理）。
// 边界样例见仓库根 testdata/zoned-day-bounds-cases.json（双端单测同读）。
func CalendarDayBounds(year, month, day int, tz string) (start, end time.Time, err error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("Invalid time zone: %s", tz)
	}
	start = time.Date(year, time.Month(month), day, 0, 0, 0, 0, loc)
	end = start.AddDate(0, 0, 1)
	return start, end, nil
}
