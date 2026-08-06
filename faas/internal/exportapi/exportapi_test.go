package exportapi

import (
	"net/url"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/recordjsonl"
)

func TestParseExportRecordsParams(t *testing.T) {
	_, err := ParseExportRecordsParams(url.Values{})
	if err == nil || err.Message != ErrExportLimitError {
		t.Fatalf("missing limit: %v", err)
	}
	_, err = ParseExportRecordsParams(url.Values{"limit": {"0"}})
	if err == nil || err.Message != ErrExportLimitError {
		t.Fatalf("limit 0: %v", err)
	}
	_, err = ParseExportRecordsParams(url.Values{"limit": {"1001"}})
	if err == nil || err.Message != ErrExportLimitError {
		t.Fatalf("limit 1001: %v", err)
	}
	_, err = ParseExportRecordsParams(url.Values{"limit": {"abc"}})
	if err == nil || err.Message != ErrExportLimitError {
		t.Fatalf("limit abc: %v", err)
	}

	p, err := ParseExportRecordsParams(url.Values{"limit": {"100"}})
	if err != nil || p.From != "" || p.Limit != 100 {
		t.Fatalf("got %+v err %v", p, err)
	}

	_, err = ParseExportRecordsParams(url.Values{"from": {"not-a-uuid"}, "limit": {"10"}})
	if err == nil || err.Message != record.ErrInvalidID {
		t.Fatalf("invalid from: %v", err)
	}

	id := "01900000-0000-7000-8000-000000000001"
	p, err = ParseExportRecordsParams(url.Values{"from": {id}, "limit": {"50"}})
	if err != nil || p.From != id || p.Limit != 50 {
		t.Fatalf("got %+v err %v", p, err)
	}
}

func TestBuildExportNdjsonAndFilename(t *testing.T) {
	empty, me := BuildExportNdjson(nil)
	if me != nil || empty != "" {
		t.Fatalf("empty: %q %v", empty, me)
	}

	num := "1.5"
	rec := record.Record{
		ID:               "01900000-0000-7000-8000-000000000001",
		HappenedAt:       "2026-07-30T00:00:00.000Z",
		NumericValue:     &num,
		RawContent:       nil,
		Tags:             []string{"weight"},
		ObjectiveContext: "scale",
		AiAnalysis:       nil,
	}
	line, err := recordjsonl.SerializeRecord(rec)
	if err != nil {
		t.Fatal(err)
	}
	body, me := BuildExportNdjson([]record.Record{rec})
	if me != nil {
		t.Fatal(me)
	}
	if body != line+"\n" {
		t.Fatalf("body %q want %q", body, line+"\n")
	}

	now := time.Date(2026, 8, 3, 8, 41, 0, 123000000, time.UTC)
	if got := ExportFilename("", 100, now); got != "records-from-start-limit-100-20260803T084100Z.jsonl" {
		t.Fatalf("filename start: %s", got)
	}
	if got := ExportFilename(rec.ID, 50, now); got != "records-from-01900000-0000-7000-8000-000000000001-limit-50-20260803T084100Z.jsonl" {
		t.Fatalf("filename from: %s", got)
	}
	if got := ExportContentDisposition("", 10, now); got != `attachment; filename="records-from-start-limit-10-20260803T084100Z.jsonl"` {
		t.Fatalf("disposition: %s", got)
	}
	if got := FormatExportNotifyMessage(0, "", 100); got != "Exported 0 records (from start, limit 100)" {
		t.Fatalf("notify: %s", got)
	}
	if got := FormatExportNotifyMessage(3, rec.ID, 50); got != "Exported 3 records (from 01900000-0000-7000-8000-000000000001, limit 50)" {
		t.Fatalf("notify from: %s", got)
	}
	if ErrExportFromNotFound != "export from id not found" {
		t.Fatal(ErrExportFromNotFound)
	}
}
