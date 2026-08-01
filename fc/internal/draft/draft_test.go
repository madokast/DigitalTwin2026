package draft

import (
	"testing"

	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

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
		ValueNumber:      "75.5",
		ValueText:        nil,
		Tags:             []any{"weight"},
		ObjectiveContext: "morning weigh-in",
	}
	parsed, err := ParseRecordDraft(body)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ValueNumber == nil || *parsed.ValueNumber != "75.5" {
		t.Fatalf("valueNumber: %#v", parsed.ValueNumber)
	}
	if parsed.ValueText != nil {
		t.Fatal("valueText should be nil")
	}
}

func TestParseHappenedAt(t *testing.T) {
	if _, err := ParseHappenedAt("2026-07-30T00:00:00.000Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseHappenedAt("2026-07-30T08:00:00+08:00"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"2026-07-30", "2026-07-30T08:00:00"} {
		_, err := ParseHappenedAt(raw)
		if err == nil || err.Error() != "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)" {
			t.Fatalf("%q: got %v", raw, err)
		}
	}
}

func TestParseValueNumber(t *testing.T) {
	got, err := ParseValueNumber("1.0")
	if err != nil || got == nil || *got != "1.0" {
		t.Fatalf("literal: %#v %v", got, err)
	}
	got, err = ParseValueNumber("  ")
	if err != nil || got != nil {
		t.Fatalf("blank: %#v %v", got, err)
	}
	if _, err := ParseValueNumber(float64(75.5)); err == nil || err.Error() != ValueNumberMustBeString {
		t.Fatalf("float64: %v", err)
	}
	for _, bad := range []string{"1e3", "1.", "+1", ".5", "01", "00.5"} {
		if _, err := ParseValueNumber(bad); err == nil || err.Error() != "Invalid value_number" {
			t.Fatalf("%q: %v", bad, err)
		}
	}
}

func TestParseRecordDraftRejectsReservedTag(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00+08:00",
		ValueNumber:      "1",
		Tags:             []string{"transaction_entry"},
		ObjectiveContext: "x",
	})
	want := tags.ReservedTagError("transaction_entry")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestParseRecordDraftRejectsNoTZ(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00",
		ValueNumber:      "1",
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
		ValueNumber:      nil,
		ValueText:        "",
		Tags:             []any{"weight"},
		ObjectiveContext: "x",
	})
	if err == nil || err.Error() != "value_number and value_text cannot both be null" {
		t.Fatalf("got %v", err)
	}
}

func TestParseRecordDraftJSON(t *testing.T) {
	raw := []byte(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"value_number":"75.5",
		"value_text":"",
		"tags":["weight"],
		"objective_context":"morning",
		"subjective_interpretation":""
	}`)
	parsed, err := ParseRecordDraftJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ValueText != nil || parsed.SubjectiveInterpretation != nil {
		t.Fatal("empty strings should become nil")
	}
	if parsed.ValueNumber == nil || *parsed.ValueNumber != "75.5" {
		t.Fatalf("number: %#v", parsed.ValueNumber)
	}
}

func TestParseRecordDraftJSONRejectsNumberType(t *testing.T) {
	raw := []byte(`{
		"happened_at":"2026-07-30T08:00:00+08:00",
		"value_number":75.5,
		"tags":["weight"],
		"objective_context":"morning"
	}`)
	_, err := ParseRecordDraftJSON(raw)
	if err == nil || err.Error() != ValueNumberMustBeString {
		t.Fatalf("got %v", err)
	}
}
