package timeutil

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type dayBoundCase struct {
	Name     string `json:"name"`
	TZ       string `json:"tz"`
	Year     int    `json:"year"`
	Month    int    `json:"month"`
	Day      int    `json:"day"`
	StartUTC string `json:"startUtc"`
	EndUTC   string `json:"endUtc"`
}

func loadDayBoundCases(t *testing.T) []dayBoundCase {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "zoned-day-bounds-cases.json"))
	if err != nil {
		t.Fatalf("read zoned-day-bounds-cases: %v", err)
	}
	var payload struct {
		Cases []dayBoundCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &payload); err != nil {
		t.Fatalf("parse zoned-day-bounds-cases: %v", err)
	}
	return payload.Cases
}

func TestExpandCompactOffset(t *testing.T) {
	cases := map[string]string{
		"2026-07-30T08:00:00+0800":     "2026-07-30T08:00:00+08:00",
		"2026-07-30T08:00:00.123-0530": "2026-07-30T08:00:00.123-05:30",
		"2026-07-30T08:00:00+08:00":    "2026-07-30T08:00:00+08:00",
		"2026-07-30T00:00:00.000Z":     "2026-07-30T00:00:00.000Z",
	}
	for in, want := range cases {
		if got := ExpandCompactOffset(in); got != want {
			t.Fatalf("%q: got %q want %q", in, got, want)
		}
	}
	got, err := ParseRFC3339Flexible("2026-07-30T08:00:00+0800")
	if err != nil {
		t.Fatal(err)
	}
	want, _ := time.Parse(time.RFC3339, "2026-07-30T08:00:00+08:00")
	if !got.Equal(want) {
		t.Fatalf("instant: got %v want %v", got, want)
	}
	for _, bad := range []string{
		"2026-07-30T08:00:00z",
		"2026-07-30 08:00:00Z",
		"2026-7-30T08:00:00Z",
		"2026-07-30T8:00:00Z",
	} {
		if _, err := ParseRFC3339Flexible(bad); err == nil {
			t.Fatalf("want reject %q", bad)
		}
	}
}

func TestEmbeddedTzdataWithoutSystemZoneinfo(t *testing.T) {
	// ZONEINFO 指向不存在路径时，须仍能靠 //go:embed 的 time/tzdata 加载
	t.Setenv("ZONEINFO", filepath.Join(t.TempDir(), "no-such-zoneinfo"))
	if !IsValidTimeZone("Asia/Shanghai") {
		t.Fatal("Asia/Shanghai should load from embedded time/tzdata")
	}
	now := time.Date(2026, 7, 30, 16, 30, 0, 0, time.UTC)
	start, end, err := GetZonedDayBounds(now, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-07-30T16:00:00Z" {
		t.Fatalf("shanghai start: %s", start.UTC())
	}
	if end.UTC().Format(time.RFC3339) != "2026-07-31T16:00:00Z" {
		t.Fatalf("shanghai end: %s", end.UTC())
	}
}

func TestIsValidTimeZone(t *testing.T) {
	if !IsValidTimeZone("Asia/Shanghai") || !IsValidTimeZone("UTC") {
		t.Fatal("expected valid zones")
	}
	if IsValidTimeZone("Not/AZone") || IsValidTimeZone("") {
		t.Fatal("expected invalid zones")
	}
	// Go LoadLocation 会收下、Intl 拒绝的非 IANA 名 → API 层须拒绝，避免双端分叉
	for _, tz := range []string{"Factory", "localtime", "posixrules"} {
		if IsValidTimeZone(tz) {
			t.Fatalf("want reject Go-only zone %q", tz)
		}
	}
	// Intl 有；Go embed 常无，但 CI 宿主 zoneinfo 可能 LoadLocation 成功 → 与 Next denylist 对齐显式拒绝
	if IsValidTimeZone("America/Coyhaique") {
		t.Fatal("want reject Intl-only America/Coyhaique")
	}
}

func TestCalendarDayBoundsSharedFixtures(t *testing.T) {
	for _, c := range loadDayBoundCases(t) {
		start, end, err := CalendarDayBounds(c.Year, c.Month, c.Day, c.TZ)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		gotStart := start.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		gotEnd := end.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		if gotStart != c.StartUTC {
			t.Fatalf("%s start: got %s want %s", c.Name, gotStart, c.StartUTC)
		}
		if gotEnd != c.EndUTC {
			t.Fatalf("%s end: got %s want %s", c.Name, gotEnd, c.EndUTC)
		}
	}
}

func TestGetZonedDayBounds(t *testing.T) {
	// 2026-07-30 16:30 UTC = 上海 7/31 00:30 → 日历日 7/31
	now := time.Date(2026, 7, 30, 16, 30, 0, 0, time.UTC)

	start, end, err := GetZonedDayBounds(now, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-07-30T16:00:00Z" {
		t.Fatalf("shanghai start: %s", start.UTC())
	}
	if end.UTC().Format(time.RFC3339) != "2026-07-31T16:00:00Z" {
		t.Fatalf("shanghai end: %s", end.UTC())
	}

	start, end, err = GetZonedDayBounds(now, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-07-30T00:00:00Z" {
		t.Fatalf("utc start: %s", start.UTC())
	}
	if end.UTC().Format(time.RFC3339) != "2026-07-31T00:00:00Z" {
		t.Fatalf("utc end: %s", end.UTC())
	}
}

type timeCase struct {
	Name        string `json:"name"`
	TZ          string `json:"tz"`
	ExpectedNow string `json:"expectedNow"`
	ExpectedTZ  string `json:"expectedTz"`
}

func TestFormatNowInZoneSharedFixtures(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "time-cases.json"))
	if err != nil {
		t.Fatalf("read time-cases: %v", err)
	}
	var payload struct {
		InstantUtcMs int64      `json:"instantUtcMs"`
		Cases        []timeCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &payload); err != nil {
		t.Fatalf("parse time-cases: %v", err)
	}
	now := time.UnixMilli(payload.InstantUtcMs).UTC()
	for _, c := range payload.Cases {
		got, err := FormatNowInZone(now, c.TZ)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got != c.ExpectedNow {
			t.Fatalf("%s now: got %s want %s", c.Name, got, c.ExpectedNow)
		}
		if c.TZ != c.ExpectedTZ {
			t.Fatalf("%s tz mismatch in fixture", c.Name)
		}
	}
	// 非法 tz → error
	if _, err := FormatNowInZone(now, "Not/AZone"); err == nil {
		t.Fatal("want error for invalid tz")
	}
}
