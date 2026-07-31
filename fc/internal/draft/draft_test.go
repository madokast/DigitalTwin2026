package draft

import (
	"testing"
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
		ValueNumber:      float64(75.5),
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

func TestParseRecordDraftRejectsNoTZ(t *testing.T) {
	_, err := ParseRecordDraft(RecordDraftBody{
		HappenedAt:       "2026-07-30T08:00:00",
		ValueNumber:      float64(1),
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
		"value_number":75.5,
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
