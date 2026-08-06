package record

import (
	"testing"
	"time"
)

func TestFormatHappenedAt(t *testing.T) {
	got := FormatHappenedAt(time.Date(2026, 7, 30, 8, 0, 0, 0, time.FixedZone("CST", 8*3600)))
	if got != "2026-07-30T00:00:00.000Z" {
		t.Fatalf("got %s", got)
	}
}

func TestFromDB(t *testing.T) {
	num := "75.5"
	rec := FromDB(DBRow{
		ID:               "01900000-0000-7000-8000-000000000001",
		HappenedAt:       time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC),
		UtcOffset:        "Z",
		NumericValue:     &num,
		RawContent:       nil,
		Tags:             `["weight"]`,
		ObjectiveContext: "morning",
		AiAnalysis:       nil,
	})
	if rec.HappenedAt != "2026-07-30T10:00:00.000Z" {
		t.Fatalf("happenedAt %s", rec.HappenedAt)
	}
	if rec.NumericValue == nil || *rec.NumericValue != "75.5" {
		t.Fatalf("numericValue %#v", rec.NumericValue)
	}

	offsetRec := FromDB(DBRow{
		ID:               "01900000-0000-7000-8000-000000000002",
		HappenedAt:       time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC),
		UtcOffset:        "+08:00",
		NumericValue:     &num,
		RawContent:       nil,
		Tags:             `["weight"]`,
		ObjectiveContext: "morning",
		AiAnalysis:       nil,
	})
	if offsetRec.HappenedAt != "2026-07-30T08:00:00.000+08:00" {
		t.Fatalf("offset happenedAt %s", offsetRec.HappenedAt)
	}
}

func TestTagsJSON(t *testing.T) {
	got, err := TagsJSON([]string{"weight", "morning"})
	if err != nil {
		t.Fatal(err)
	}
	if got != `["weight","morning"]` {
		t.Fatalf("got %s", got)
	}
}

func TestIsValidID(t *testing.T) {
	if !IsValidID("01900000-0000-7000-8000-000000000001") {
		t.Fatal("want valid UUID")
	}
	if !IsValidID("00000000-0000-0000-0000-000000000000") {
		t.Fatal("want nil UUID accepted (npm uuid)")
	}
	for _, bad := range []string{
		"",
		"not-a-uuid",
		"123",
		"01900000-0000-7000-8000",
		// 结构像 UUID 但 variant/version 非法：google/uuid.Parse 会过，npm validate 拒
		"a0eebc99-9c0b-4ef8-7000-6bb9bd380a11", // variant 7
		"01234567-89ab-cdef-0123-456789abcdef", // version c
	} {
		if IsValidID(bad) {
			t.Fatalf("want reject %q", bad)
		}
	}
}
