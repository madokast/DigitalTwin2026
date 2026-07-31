package timeutil

import (
	"testing"
	"time"
)

func TestIsValidTimeZone(t *testing.T) {
	if !IsValidTimeZone("Asia/Shanghai") || !IsValidTimeZone("UTC") {
		t.Fatal("expected valid zones")
	}
	if IsValidTimeZone("Not/AZone") || IsValidTimeZone("") {
		t.Fatal("expected invalid zones")
	}
}

func TestGetZonedDayBounds(t *testing.T) {
	now := time.Date(2026, 7, 30, 16, 30, 0, 0, time.UTC)

	start, end, err := GetZonedDayBounds(now, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-07-30T16:00:00Z" {
		t.Fatalf("shanghai start: %s", start.UTC())
	}
	if end.UTC().Format(time.RFC3339) != "2026-07-31T16:00:00Z" {
		t.Fatalf("shanghai end: %s", end.UTC())
	}

	start, end, err = GetZonedDayBounds(now, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-07-30T00:00:00Z" {
		t.Fatalf("utc start: %s", start.UTC())
	}
	if end.UTC().Format(time.RFC3339) != "2026-07-31T00:00:00Z" {
		t.Fatalf("utc end: %s", end.UTC())
	}
}
