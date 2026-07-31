package logapi

import (
	"context"
	"testing"

	"github.com/mdk/digitaltwin2026/fc/internal/draft"
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
