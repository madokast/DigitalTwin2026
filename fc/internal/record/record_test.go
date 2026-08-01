package record

import (
	"context"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/fc/internal/draft"
)

func TestFormatHappenedAt(t *testing.T) {
	got := FormatHappenedAt(time.Date(2026, 7, 30, 8, 0, 0, 0, time.FixedZone("CST", 8*3600)))
	if got != "2026-07-30T00:00:00.000Z" {
		t.Fatalf("got %s", got)
	}
}

func TestFromDB(t *testing.T) {
	num := "75.5"
	rec := FromDB(
		"01900000-0000-7000-8000-000000000001",
		time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC),
		&num,
		nil,
		`["weight"]`,
		"morning",
		nil,
	)
	if rec.HappenedAt != "2026-07-30T10:00:00.000Z" {
		t.Fatalf("happenedAt %s", rec.HappenedAt)
	}
	if rec.ValueNumber == nil || *rec.ValueNumber != "75.5" {
		t.Fatalf("valueNumber %#v", rec.ValueNumber)
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

func TestUpdateRejectsInvalidID(t *testing.T) {
	_, status, err := Update(context.Background(), nil, "not-a-uuid", &draft.NormalizedRecordDraft{})
	if status != 400 || err == nil || err.Error() != InvalidID.Error() {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

// Update 写库路径见 record_db_test.go（假 Querier）。
// 此处锁定用户可见错误文案与 TS RECORD_NOT_FOUND 字节一致。
func TestUpdateNotFoundErrorMessage(t *testing.T) {
	if ErrNotFound.Error() != "Record not found" {
		t.Fatalf("ErrNotFound %q must stay byte-identical to TS RECORD_NOT_FOUND", ErrNotFound.Error())
	}
}
