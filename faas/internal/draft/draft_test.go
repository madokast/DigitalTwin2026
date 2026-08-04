package draft

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/tags"
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

func TestEmptyStringToNull(t *testing.T) {
	empty := ""
	if EmptyStringToNull(&empty) != nil {
		t.Fatal("empty -> nil")
	}
	if EmptyStringToNull(nil) != nil {
		t.Fatal("nil -> nil")
	}
	s := "hello"
	if got := EmptyStringToNull(&s); got == nil || *got != "hello" {
		t.Fatal("keep non-empty")
	}
}

func TestParseRecordDraftValid(t *testing.T) {
	body := RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00+08:00",
		NumericValue:      "75.5",
		RawContent:        nil,
		Tags:             []any{"weight"},
		ObjectiveContext: "morning weigh-in",
	}
	parsed, err := ParseRecordDraft(body)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.NumericValue == nil || *parsed.NumericValue != "75.5" {
		t.Fatalf("numericValue: %#v", parsed.NumericValue)
	}
	if parsed.RawContent != nil {
		t.Fatal("rawContent should be nil")
	}
	if parsed.HappenedAt == nil || parsed.UtcOffset == nil || *parsed.UtcOffset != "+08:00" {
		t.Fatalf("time fields: happened=%v offset=%v", parsed.HappenedAt, parsed.UtcOffset)
	}
}

func TestParseRecordDraftOmitsHappenedAt(t *testing.T) {
	body := RecordDraftBody{
		NumericValue:      "75.5",
		Tags:             []any{"weight"},
		ObjectiveContext: "morning weigh-in",
	}
	parsed, err := ParseRecordDraft(body)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.HappenedAt != nil || parsed.UtcOffset != nil {
		t.Fatalf("expected nil time fields, got happened=%v offset=%v", parsed.HappenedAt, parsed.UtcOffset)
	}
}

func TestParseRecordDraftJSONRejectsUtcOffset(t *testing.T) {
	raw := []byte(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"numeric_value":"1",
		"tags":["weight"],
		"objective_context":"x",
		"utc_offset":"+08:00"
	}`)
	_, err := ParseRecordDraftJSON(raw)
	if err == nil || err.Error() != "Unknown JSON key: utc_offset" {
		t.Fatalf("got %v", err)
	}
}

func TestParseRecordDraftJSONOmitsHappenedAt(t *testing.T) {
	raw := []byte(`{
		"numeric_value":"1",
		"tags":["weight"],
		"objective_context":"x"
	}`)
	parsed, err := ParseRecordDraftJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.HappenedAt != nil || parsed.UtcOffset != nil {
		t.Fatalf("expected omit: %#v", parsed)
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
		if err == nil || err.Error() != "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)" {
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
		if err == nil || err.Error() != "Invalid happened_at datetime" {
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
		if err := ValidateDecimalString(bad); err == nil || err.Error() != "Invalid numeric_value" {
			t.Fatalf("reject ValidateDecimalString %q: %v", bad, err)
		}
		if _, err := ParseNumericValue(bad); err == nil || err.Error() != "Invalid numeric_value" {
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
	if _, err := ParseNumericValue(float64(75.5)); err == nil || err.Error() != NumericValueMustBeString {
		t.Fatalf("float64: %v", err)
	}
}

func TestParseRecordDraftRejectsReservedTag(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00+08:00",
		NumericValue:      "1",
		Tags:             []string{"transaction_entry"},
		ObjectiveContext: "x",
	})
	want := tags.ReservedTagError("transaction_entry")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestParseRecordDraftRejectsReservedPrefixedTag(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00+08:00",
		NumericValue:      "1",
		Tags:             []string{"transaction_entry:income"},
		ObjectiveContext: "x",
	})
	want := tags.ReservedTagError("transaction_entry:income")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestParseRecordDraftRejectsTodoReservedTag(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00+08:00",
		NumericValue:      "1",
		Tags:             []string{"todo:in_progress"},
		ObjectiveContext: "x",
	})
	want := tags.ReservedTagError("todo:in_progress")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestParseRecordDraftRejectsNoTZ(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00",
		NumericValue:      "1",
		Tags:             []any{"weight"},
		ObjectiveContext: "x",
	})
	if err == nil || err.Error() != "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)" {
		t.Fatalf("got %v", err)
	}
}

func TestParseRecordDraftBothNull(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00+08:00",
		NumericValue:      nil,
		RawContent:        "",
		Tags:             []any{"weight"},
		ObjectiveContext: "x",
	})
	if err == nil || err.Error() != "numeric_value and raw_content cannot both be null" {
		t.Fatalf("got %v", err)
	}
}

func TestParseRecordDraftJSON(t *testing.T) {
	raw := []byte(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"numeric_value":"75.5",
		"raw_content":"",
		"tags":["weight"],
		"objective_context":"morning",
		"subjective_interpretation":""
	}`)
	parsed, err := ParseRecordDraftJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.RawContent != nil || parsed.SubjectiveInterpretation != nil {
		t.Fatal("empty strings should become nil")
	}
	if parsed.NumericValue == nil || *parsed.NumericValue != "75.5" {
		t.Fatalf("number: %#v", parsed.NumericValue)
	}
}

func TestParseRecordDraftJSONRejectsNumberType(t *testing.T) {
	raw := []byte(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"numeric_value":75.5,
		"tags":["weight"],
		"objective_context":"morning"
	}`)
	_, err := ParseRecordDraftJSON(raw)
	if err == nil || err.Error() != NumericValueMustBeString {
		t.Fatalf("got %v", err)
	}
}
