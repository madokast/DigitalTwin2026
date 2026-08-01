package transactiondraft

import (
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/fc/internal/tags"
)

func TestParseTransactionBatchRejectsEmptyEntries(t *testing.T) {
	raw := []byte(`{"happened_at":"2026-08-01T12:30:00+08:00","type":"expense","entries":[]}`)
	_, err := ParseTransactionBatch(raw)
	if err == nil || err.Error() != "entries must be a non-empty array" {
		t.Fatalf("err=%v", err)
	}
}

func TestParseTransactionBatchRejectsJSONNumberAmount(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"type": "expense",
		"entries": [{"amount": 25, "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, err := ParseTransactionBatch(raw)
	if err == nil || !strings.Contains(err.Error(), AmountMustBeString) {
		t.Fatalf("err=%v", err)
	}
}

func TestParseTransactionBatchRejectsMissingType(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"entries": [{"amount": "25.00", "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, err := ParseTransactionBatch(raw)
	if err == nil || err.Error() != "Missing required field: type" {
		t.Fatalf("err=%v", err)
	}
}

func TestParseTransactionBatchRejectsZeroAmount(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"type": "income",
		"entries": [{"amount": "0.00", "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, err := ParseTransactionBatch(raw)
	want := "entries[0]: " + AmountMustNotBeZero
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestParseTransactionBatchOK(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"type": "expense",
		"entries": [
			{"amount": "25.00", "memo": "lunch", "category": "food", "subcategory": "lunch"},
			{"amount": "-5.00", "memo": "refund", "category": "food", "subcategory": "lunch"}
		]
	}`)
	batch, err := ParseTransactionBatch(raw)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if batch.Type != "expense" {
		t.Fatalf("type=%q", batch.Type)
	}
	if len(batch.Entries) != 2 {
		t.Fatalf("len=%d", len(batch.Entries))
	}
	wantTag := tags.TransactionEntryTypeTag("expense")
	if batch.Entries[0].Amount != "25.00" || batch.Entries[0].Memo != "lunch" {
		t.Fatalf("entry0=%+v", batch.Entries[0])
	}
	if len(batch.Entries[0].Tags) != 2 || batch.Entries[0].Tags[0] != wantTag || batch.Entries[0].Tags[1] != "food:lunch" {
		t.Fatalf("tags=%v", batch.Entries[0].Tags)
	}
	if batch.Entries[1].Amount != "-5.00" {
		t.Fatalf("entry1 amount=%q", batch.Entries[1].Amount)
	}
}

func TestIsZeroDecimalLiteral(t *testing.T) {
	for _, s := range []string{"0", "0.0", "0.00", "-0", "-0.00"} {
		if !IsZeroDecimalLiteral(s) {
			t.Errorf("expected zero: %q", s)
		}
	}
	for _, s := range []string{"1", "0.01", "-0.1", "10"} {
		if IsZeroDecimalLiteral(s) {
			t.Errorf("expected non-zero: %q", s)
		}
	}
}
