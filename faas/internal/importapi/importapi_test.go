package importapi_test

import (
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
)

func TestFormatImportNotifyAndDuplicate(t *testing.T) {
	got := importapi.FormatImportNotifyMessage(importapi.Counts{Inserted: 12, Updated: 3, Total: 15})
	if got != "Imported 15 records (inserted 12, updated 3)" {
		t.Fatalf("notify %q", got)
	}
	zero := importapi.FormatImportNotifyMessage(importapi.Counts{})
	if zero != "Imported 0 records (inserted 0, updated 0)" {
		t.Fatalf("zero notify %q", zero)
	}
	id := "01900000-0000-7000-8000-000000000001"
	dup := importapi.FormatDuplicateIDError(id, 2)
	want := "line 2: duplicate record id " + id
	if dup != want {
		t.Fatalf("dup %q want %q", dup, want)
	}
}

func TestIsAcceptedImportFilePart(t *testing.T) {
	cases := []struct {
		ct, name string
		ok       bool
	}{
		{"application/x-ndjson", "x.bin", true},
		{"application/jsonl; charset=utf-8", "x", true},
		{"application/octet-stream", "records.JSONL", true},
		{"application/octet-stream", "records.txt", false},
		{"text/plain", "records.jsonl", false},
	}
	for _, tc := range cases {
		if importapi.IsAcceptedImportFilePart(tc.ct, tc.name) != tc.ok {
			t.Fatalf("%q %q → want %v", tc.ct, tc.name, tc.ok)
		}
	}
}

func TestImportLimitsConstant(t *testing.T) {
	if importapi.MaxImportLines != 1000 {
		t.Fatalf("lines %d", importapi.MaxImportLines)
	}
	if importapi.MaxImportFileBytes != 4*1024*1024 {
		t.Fatalf("bytes %d", importapi.MaxImportFileBytes)
	}
	if !strings.Contains(importapi.ErrImportLimitsError.Error(), "split the file") {
		t.Fatalf("limits msg %v", importapi.ErrImportLimitsError)
	}
}
