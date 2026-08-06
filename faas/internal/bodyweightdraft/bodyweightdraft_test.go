package bodyweightdraft

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

type weightAmountAccept struct {
	Input  string `json:"input"`
	Stored string `json:"stored"`
}

type weightAmountReject struct {
	Input string `json:"input"`
	Error string `json:"error"`
}

type weightAmountCases struct {
	InvalidWeightError          string               `json:"invalidWeightError"`
	ErrNumericValueMustBeString string               `json:"numericValueMustBeString"`
	Accept                      []weightAmountAccept `json:"accept"`
	Reject                      []weightAmountReject `json:"reject"`
}

func loadWeightAmountCases(t *testing.T) weightAmountCases {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "weight-amount-cases.json"))
	if err != nil {
		t.Fatalf("read weight-amount-cases: %v", err)
	}
	var cases weightAmountCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse weight-amount-cases: %v", err)
	}
	return cases
}

func TestParseWeightAmountSharedFixtures(t *testing.T) {
	cases := loadWeightAmountCases(t)
	if ErrInvalidWeight.Error() != cases.InvalidWeightError {
		t.Fatalf("ErrInvalidWeight constant drift: %q vs %q", ErrInvalidWeight, cases.InvalidWeightError)
	}
	if draft.ErrNumericValueMustBeString.Error() != cases.ErrNumericValueMustBeString {
		t.Fatalf("ErrNumericValueMustBeString drift")
	}
	for _, tc := range cases.Accept {
		got, err := ParseWeightAmount(tc.Input)
		if err != nil || got != tc.Stored {
			t.Fatalf("accept %q: got=%q err=%v want=%q", tc.Input, got, err, tc.Stored)
		}
	}
	for _, tc := range cases.Reject {
		_, err := ParseWeightAmount(tc.Input)
		if err == nil || err.Error() != tc.Error {
			t.Fatalf("reject %q: err=%v want=%q", tc.Input, err, tc.Error)
		}
	}
	_, err := ParseWeightAmount(float64(75.5))
	if err == nil || err.Error() != draft.ErrNumericValueMustBeString.Error() {
		t.Fatalf("JSON number: err=%v", err)
	}
}

func TestParseBodyWeight(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": "75.5",
		"objective_context": "morning weigh-in",
		"ai_analysis": "a bit heavy",
		"tags": ["morning"]
	}`)
	got, err := ParseBodyWeight(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.NumericValue != "75.50" {
		t.Fatalf("value=%q", got.NumericValue)
	}
	if len(got.Tags) != 2 || got.Tags[0] != tags.ReservedTagBodyWeight || got.Tags[1] != "morning" {
		t.Fatalf("tags=%v", got.Tags)
	}
}

func TestParseBodyWeightOmitsTags(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": "75",
		"objective_context": "x"
	}`)
	got, err := ParseBodyWeight(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 1 || got.Tags[0] != tags.ReservedTagBodyWeight {
		t.Fatalf("tags=%v", got.Tags)
	}
	if got.NumericValue != "75.00" {
		t.Fatalf("value=%q", got.NumericValue)
	}
}

func TestParseBodyWeightRejectsReservedClientTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": "75",
		"objective_context": "x",
		"tags": ["body:weight"]
	}`)
	_, err := ParseBodyWeight(raw)
	want := tags.ReservedTagError("body:weight")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v want=%q", err, want)
	}
}

func TestParseBodyWeightRejectsDuplicateClientTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": "75.5",
		"objective_context": "x",
		"tags": ["morning", "morning"]
	}`)
	_, err := ParseBodyWeight(raw)
	if err == nil || err.Error() != `duplicate tag "morning"` {
		t.Fatalf("err: %v", err)
	}
}
