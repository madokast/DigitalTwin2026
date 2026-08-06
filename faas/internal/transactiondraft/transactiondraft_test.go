package transactiondraft

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

type moneyAmountAccept struct {
	Input  string `json:"input"`
	Stored string `json:"stored"`
}

type moneyAmountReject struct {
	Input string `json:"input"`
	Error string `json:"error"`
}

type moneyAmountCases struct {
	InvalidAmountError string              `json:"invalidAmountError"`
	Accept             []moneyAmountAccept `json:"accept"`
	Reject             []moneyAmountReject `json:"reject"`
}

func loadMoneyAmountCases(t *testing.T) moneyAmountCases {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "money-amount-cases.json"))
	if err != nil {
		t.Fatalf("read money-amount-cases: %v", err)
	}
	var cases moneyAmountCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse money-amount-cases: %v", err)
	}
	return cases
}

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
	want := "entries[0]: " + ErrAmountMustBeString
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}

func TestParseTransactionBatchRejectsMissingType(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"entries": [{"amount": "25.00", "memo": "x", "category": "food", "subcategory": "lunch"}]
	}`)
	_, err := ParseTransactionBatch(raw)
	if err == nil || err.Error() != "missing required field: type" {
		t.Fatalf("err=%v", err)
	}
}

func TestParseTransactionBatchSharedMoneyAmountFixtures(t *testing.T) {
	cases := loadMoneyAmountCases(t)
	if cases.InvalidAmountError != ErrInvalidAmount {
		t.Fatalf("fixture invalidAmountError %q != const %q", cases.InvalidAmountError, ErrInvalidAmount)
	}
	for _, c := range cases.Accept {
		raw := []byte(`{
			"happened_at": "2026-08-01T12:30:00+08:00",
			"type": "expense",
			"entries": [{"amount": ` + jsonString(c.Input) + `, "memo": "x", "category": "food", "subcategory": "lunch"}]
		}`)
		batch, err := ParseTransactionBatch(raw)
		if err != nil {
			t.Fatalf("accept %q: err=%v", c.Input, err)
		}
		if batch.Entries[0].Amount != c.Stored {
			t.Fatalf("accept %q: got %q want %q", c.Input, batch.Entries[0].Amount, c.Stored)
		}
	}
	for _, c := range cases.Reject {
		raw := []byte(`{
			"happened_at": "2026-08-01T12:30:00+08:00",
			"type": "expense",
			"entries": [{"amount": ` + jsonString(c.Input) + `, "memo": "x", "category": "food", "subcategory": "lunch"}]
		}`)
		_, err := ParseTransactionBatch(raw)
		want := "entries[0]: " + c.Error
		if err == nil || err.Error() != want {
			t.Fatalf("reject %q: err=%v want %q", c.Input, err, want)
		}
	}
}

func jsonString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestNormalizeMoneyAmount(t *testing.T) {
	if got := NormalizeMoneyAmount("10"); got != "10.00" {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeMoneyAmount("10.5"); got != "10.50" {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeMoneyAmount("-1.5"); got != "-1.50" {
		t.Fatalf("got %q", got)
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

func TestParseTransactionBatchRejectsBadCategory(t *testing.T) {
	for _, cat := range []string{"food:x", "food x", "food\u00a0x"} {
		raw := []byte(`{
			"happened_at": "2026-08-01T12:30:00+08:00",
			"type": "expense",
			"entries": [{"amount": "25.00", "memo": "x", "category": "` + cat + `", "subcategory": "lunch"}]
		}`)
		_, err := ParseTransactionBatch(raw)
		if err == nil || !strings.Contains(err.Error(), "invalid category") {
			t.Fatalf("category %q: err=%v", cat, err)
		}
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
