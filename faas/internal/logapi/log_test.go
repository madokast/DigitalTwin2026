package logapi

import (
	"context"
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/draft"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
	"github.com/mdk/digitaltwin2026/faas/internal/transactiondraft"
)


func TestCreateTextRejectsReservedTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"raw_content": "should fail",
		"tags": ["transaction_entry"],
		"objective_context": "x"
	}`)
	_, status, err := CreateText(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := tags.ReservedTagError("transaction_entry")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateTextRejectsTodoReservedTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"raw_content": "should fail",
		"tags": ["todo:in_progress"],
		"objective_context": "x"
	}`)
	_, status, err := CreateText(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := tags.ReservedTagError("todo:in_progress")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateTransactionBatchRejectsEmptyEntries(t *testing.T) {
	raw := []byte(`{"happened_at":"2026-08-01T12:30:00+08:00","type":"expense","entries":[]}`)
	_, _, _, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
	if status != 400 || err == nil || err.Error() != "entries must be a non-empty array" {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

func TestCreateTransactionBatchRejectsJSONNumberAmount(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"type": "expense",
		"entries": [{"amount": 25, "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, _, _, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	if err == nil || !strings.Contains(err.Error(), transactiondraft.AmountMustBeString) {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateTransactionBatchRejectsMissingType(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"entries": [{"amount": "25.00", "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, _, _, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
	if status != 400 || err == nil || err.Error() != "Missing required field: type" {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

func TestCreateTransactionBatchRejectsZeroAmount(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"type": "income",
		"entries": [{"amount": "0.00", "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, _, _, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := "entries[0]: " + transactiondraft.InvalidAmount
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestOptionalAiAnalysis(t *testing.T) {
	t.Parallel()

	if v, err := draft.OptionalTrimmedNullable(nil, "ai_analysis"); err != nil || v != nil {
		t.Fatalf("nil: got (%v, %v)", v, err)
	}
	if v, err := draft.OptionalTrimmedNullable("", "ai_analysis"); err == nil || err.Error() != "ai_analysis must not be blank" {
		t.Fatalf("empty: got (%v, %v)", v, err)
	}
	if v, err := draft.OptionalTrimmedNullable("  ok  ", "ai_analysis"); err != nil || v == nil || *v != "ok" {
		t.Fatalf("string: got (%v, %v)", v, err)
	}
	for _, bad := range []any{1, true, []any{}, map[string]any{}} {
		if _, err := draft.OptionalTrimmedNullable(bad, "ai_analysis"); err == nil || err.Error() != "Invalid ai_analysis" {
			t.Fatalf("%v: want Invalid ai_analysis, got %v", bad, err)
		}
	}
}

func TestCreateNumberBatchValidation(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{
			"empty entries",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[]}`,
			"entries must be a non-empty array",
		},
		{
			"missing happened_at",
			`{"entries":[{"numeric_value":"1","memo":"x"}]}`,
			"Missing required field: happened_at",
		},
		{
			"missing numeric_value",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"memo":"x"}]}`,
			"entries[0]: Missing required field: numeric_value",
		},
		{
			"json number numeric_value",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":36.8,"memo":"x"}]}`,
			"entries[0]: numeric_value must be a decimal string",
		},
		{
			"missing memo",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1"}]}`,
			"entries[0]: Missing required field: memo",
		},
		{
			"reserved tag",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1","memo":"x","tags":["body:weight"]}]}`,
			`entries[0]: tag "body:weight" is reserved; use the dedicated log API for this record type`,
		},
	}
	for _, c := range cases {
		_, _, status, err := CreateNumberBatch(context.Background(), nil, []byte(c.raw))
		if status != 400 {
			t.Fatalf("%s: status %d", c.name, status)
		}
		if err == nil || err.Error() != c.want {
			t.Fatalf("%s: got %v want %q", c.name, err, c.want)
		}
	}
}
