package draft

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type decimalStringCases struct {
	Accept []string `json:"accept"`
	Reject []string `json:"reject"`
}

func loadDecimalStringCases(t *testing.T) decimalStringCases {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "decimal-string-cases.json"))
	if err != nil {
		t.Fatalf("read decimal-string-cases: %v", err)
	}
	var cases decimalStringCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse decimal-string-cases: %v", err)
	}
	return cases
}

func TestRequireTrimmedTextAndOptionalTrimmedNullable(t *testing.T) {
	if _, me := RequireTrimmedText("", "raw_content"); me == nil || me.Message != "missing required field: raw_content" {
		t.Fatalf("empty: %v", me)
	}
	if _, me := RequireTrimmedText("   ", "raw_content"); me == nil || me.Message != "raw_content must not be blank" {
		t.Fatalf("blank: %v", me)
	}
	if v, me := RequireTrimmedText("  ok  ", "raw_content"); me != nil || v != "ok" {
		t.Fatalf("trim: (%q, %v)", v, me)
	}
	if v, me := OptionalTrimmedNullable(nil, "ai_analysis"); me != nil || v != nil {
		t.Fatalf("nil: (%v, %v)", v, me)
	}
	if _, me := OptionalTrimmedNullable("", "ai_analysis"); me == nil || me.Message != "ai_analysis must not be blank" {
		t.Fatalf("empty: %v", me)
	}
	if v, me := OptionalTrimmedNullable("  ok  ", "ai_analysis"); me != nil || v == nil || *v != "ok" {
		t.Fatalf("trim: (%v, %v)", v, me)
	}
}

func TestParseHappenedAt(t *testing.T) {
	if _, offset, err := ParseHappenedAt("2026-07-30T00:00:00.000Z"); err != nil {
		t.Fatal(err)
	} else if offset != "Z" {
		t.Fatalf("offset=%q want Z", offset)
	}
	if _, offset, err := ParseHappenedAt("2026-07-30T08:00:00+08:00"); err != nil {
		t.Fatal(err)
	} else if offset != "+08:00" {
		t.Fatalf("offset=%q want +08:00", offset)
	}
	// 契约 / Next 允许 ±HHMM（无冒号）；须与 ±HH:MM 等价，不能 400
	got, offset, err := ParseHappenedAt("2026-07-30T08:00:00+0800")
	if err != nil {
		t.Fatalf("+0800: %v", err)
	}
	if offset != "+08:00" {
		t.Fatalf("+0800 offset=%q", offset)
	}
	want, _ := time.Parse(time.RFC3339, "2026-07-30T08:00:00+08:00")
	if !got.Equal(want) {
		t.Fatalf("+0800 instant: got %v want %v", got, want)
	}
	for _, raw := range []string{"2026-07-30", "2026-07-30T08:00:00"} {
		_, _, err := ParseHappenedAt(raw)
		if err == nil || err.Message != "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)" {
			t.Fatalf("%q: got %v", raw, err)
		}
	}
	// Date/ECMA 会收下、Go RFC3339 拒绝的形态 → Invalid happened_at datetime
	for _, raw := range []string{
		"2026-07-30T08:00:00z",
		"2026-07-30 08:00:00Z",
		"2026-7-30T08:00:00Z",
		"2026-07-30T8:00:00Z",
	} {
		_, _, err := ParseHappenedAt(raw)
		if err == nil || err.Message != "invalid happened_at datetime" {
			t.Fatalf("%q: got %v", raw, err)
		}
	}
}

func TestValidateDecimalStringSharedFixtures(t *testing.T) {
	cases := loadDecimalStringCases(t)
	for _, s := range cases.Accept {
		if err := ValidateDecimalString(s); err != nil {
			t.Fatalf("accept %q: %v", s, err)
		}
		got, err := ParseNumericValue(s)
		if err != nil || got == nil || *got != s {
			t.Fatalf("ParseNumericValue accept %q: %#v %v", s, got, err)
		}
	}
	for _, bad := range cases.Reject {
		if err := ValidateDecimalString(bad); err == nil || err.Message != "invalid numeric_value" {
			t.Fatalf("reject ValidateDecimalString %q: %v", bad, err)
		}
		if _, err := ParseNumericValue(bad); err == nil || err.Message != "invalid numeric_value" {
			t.Fatalf("reject ParseNumericValue %q: %v", bad, err)
		}
	}
}

func TestParseNumericValueBlankAndJSONNumber(t *testing.T) {
	got, err := ParseNumericValue("  1.0  ")
	if err != nil || got == nil || *got != "1.0" {
		t.Fatalf("trim: %#v %v", got, err)
	}
	got, err = ParseNumericValue("  ")
	if err != nil || got != nil {
		t.Fatalf("blank: %#v %v", got, err)
	}
	if _, err := ParseNumericValue(float64(75.5)); err == nil || err.Message != ErrNumericValueMustBeString {
		t.Fatalf("float64: %v", err)
	}
}
