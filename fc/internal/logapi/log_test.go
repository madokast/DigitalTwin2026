package logapi

import (
	"context"
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/fc/internal/draft"
	"github.com/mdk/digitaltwin2026/fc/internal/tags"
	"github.com/mdk/digitaltwin2026/fc/internal/transactiondraft"
)

func TestCreateNumberRejectsMissingTimezone(t *testing.T) {
	for _, happened := range []string{"2026-07-30", "2026-07-30T08:00:00"} {
		raw := []byte(`{
			"happened_at": "` + happened + `",
			"value_number": "1",
			"tags": ["weight"],
			"objective_context": "x"
		}`)
		_, status, err := CreateNumber(context.Background(), nil, raw)
		if status != 400 {
			t.Fatalf("%q status %d", happened, status)
		}
		want := "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"
		if err == nil || err.Error() != want {
			t.Fatalf("%q err=%v", happened, err)
		}
	}
}

func TestCreateNumberRejectsUnknownKey(t *testing.T) {
	raw := []byte(`{
		"happened_at":"2024-01-01T00:00:00Z",
		"value_number":"1",
		"tags":["a"],
		"objective_context":"o",
		"extra":true
	}`)
	_, status, err := CreateNumber(context.Background(), nil, raw)
	if status != 400 || err == nil || err.Error() != "Unknown JSON key: extra" {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

func TestCreateNumberRejectsJSONNumber(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-07-30T08:00:00+08:00",
		"value_number": 75.5,
		"tags": ["weight"],
		"objective_context": "x"
	}`)
	_, status, err := CreateNumber(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	if err == nil || err.Error() != draft.ValueNumberMustBeString {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateNumberRejectsBadDecimals(t *testing.T) {
	for _, bad := range []string{"1e3", "1.", "+1"} {
		raw := []byte(`{
			"happened_at": "2026-07-30T08:00:00+08:00",
			"value_number": "` + bad + `",
			"tags": ["weight"],
			"objective_context": "x"
		}`)
		_, status, err := CreateNumber(context.Background(), nil, raw)
		if status != 400 || err == nil || err.Error() != "Invalid value_number" {
			t.Fatalf("%q: status=%d err=%v", bad, status, err)
		}
	}
}

func TestCreateNumberAcceptsTimezone(t *testing.T) {
	// 仅校验解析路径；nil pool 会在通过校验后于 INSERT 失败。
	for _, happened := range []string{
		"2026-07-30T00:00:00.000Z",
		"2026-07-30T08:00:00+08:00",
	} {
		if _, err := draft.ParseHappenedAt(happened); err != nil {
			t.Fatalf("%q: %v", happened, err)
		}
	}
	got, err := draft.ParseValueNumber("75.5")
	if err != nil || got == nil || *got != "75.5" {
		t.Fatalf("ParseValueNumber: %#v %v", got, err)
	}
}

func TestCreateTextRejectsMissingTimezone(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-07-30T10:00:00",
		"value_text": "hello",
		"tags": ["study"],
		"objective_context": "x"
	}`)
	_, status, err := CreateText(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := "happened_at must be ISO 8601 with timezone (Z or ±HH:MM)"
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateNumberRejectsReservedTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"value_number": "1",
		"tags": ["transaction_entry"],
		"objective_context": "x"
	}`)
	_, status, err := CreateNumber(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := tags.ReservedTagError("transaction_entry")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateNumberRejectsReservedPrefixedTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"value_number": "1",
		"tags": ["transaction_entry:income"],
		"objective_context": "x"
	}`)
	_, status, err := CreateNumber(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := tags.ReservedTagError("transaction_entry:income")
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateTextRejectsReservedTag(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"value_text": "should fail",
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

func TestCreateTransactionBatchRejectsEmptyEntries(t *testing.T) {
	raw := []byte(`{"happened_at":"2026-08-01T12:30:00+08:00","type":"expense","entries":[]}`)
	_, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
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
	_, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
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
	_, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
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
	_, _, status, err := CreateTransactionBatch(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := "entries[0]: " + transactiondraft.AmountMustNotBeZero
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestOptionalSubjective(t *testing.T) {
	t.Parallel()

	if v, err := optionalSubjective(nil); err != nil || v != nil {
		t.Fatalf("nil: got (%v, %v)", v, err)
	}
	if v, err := optionalSubjective(""); err != nil || v != nil {
		t.Fatalf("empty: got (%v, %v)", v, err)
	}
	if v, err := optionalSubjective("ok"); err != nil || v != "ok" {
		t.Fatalf("string: got (%v, %v)", v, err)
	}
	for _, bad := range []any{1, true, []any{}, map[string]any{}} {
		if _, err := optionalSubjective(bad); err == nil || err.Error() != "Invalid subjective_interpretation" {
			t.Fatalf("%v: want Invalid subjective_interpretation, got %v", bad, err)
		}
	}
}
