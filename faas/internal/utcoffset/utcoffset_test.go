package utcoffset

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type extractCase struct {
	Name      string  `json:"name"`
	Input     string  `json:"input"`
	UtcOffset *string `json:"utc_offset"`
	Error     *string `json:"error"`
}

type formatCase struct {
	Name       string `json:"name"`
	InstantUTC string `json:"instant_utc"`
	UtcOffset  string `json:"utc_offset"`
	Want       string `json:"want"`
}

func loadFixtures(t *testing.T) (extract []extractCase, format []formatCase) {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "utc-offset-cases.json"))
	if err != nil {
		t.Fatalf("read utc-offset-cases: %v", err)
	}
	var payload struct {
		Extract []extractCase `json:"extract"`
		Format  []formatCase  `json:"format"`
	}
	if err := json.Unmarshal(b, &payload); err != nil {
		t.Fatalf("parse utc-offset-cases: %v", err)
	}
	return payload.Extract, payload.Format
}

func TestExtractUtcOffsetLiteral(t *testing.T) {
	extract, _ := loadFixtures(t)
	for _, c := range extract {
		t.Run(c.Name, func(t *testing.T) {
			got, err := ExtractUtcOffsetLiteral(c.Input)
			if c.Error != nil {
				if err == nil {
					t.Fatalf("want error %q, got %q", *c.Error, got)
				}
				if err.Message != *c.Error {
					t.Fatalf("error: got %q want %q", err.Message, *c.Error)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if c.UtcOffset == nil {
				t.Fatal("fixture missing utc_offset")
			}
			if got != *c.UtcOffset {
				t.Fatalf("got %q want %q", got, *c.UtcOffset)
			}
		})
	}

	t.Run("does-not-fold-Z-and-plus00", func(t *testing.T) {
		z, err := ExtractUtcOffsetLiteral("2026-08-03T08:00:00Z")
		if err != nil || z != "Z" {
			t.Fatalf("Z: got %q %v", z, err)
		}
		plus, err := ExtractUtcOffsetLiteral("2026-08-03T08:00:00+00:00")
		if err != nil || plus != "+00:00" {
			t.Fatalf("+00:00: got %q %v", plus, err)
		}
	})
}

func TestFormatHappenedAt(t *testing.T) {
	_, format := loadFixtures(t)
	for _, c := range format {
		t.Run(c.Name, func(t *testing.T) {
			instant, err := time.Parse(time.RFC3339Nano, c.InstantUTC)
			if err != nil {
				t.Fatalf("parse instant: %v", err)
			}
			got, me := FormatHappenedAt(instant, c.UtcOffset)
			if me != nil {
				t.Fatalf("FormatHappenedAt: %v", me)
			}
			if got != c.Want {
				t.Fatalf("got %q want %q", got, c.Want)
			}
		})
	}

	t.Run("same-instant-keeps-Z-vs-plus00", func(t *testing.T) {
		instant := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
		z, err := FormatHappenedAt(instant, "Z")
		if err != nil || z != "2026-08-03T00:00:00.000Z" {
			t.Fatalf("Z: got %q %v", z, err)
		}
		plus, err := FormatHappenedAt(instant, "+00:00")
		if err != nil || plus != "2026-08-03T00:00:00.000+00:00" {
			t.Fatalf("+00:00: got %q %v", plus, err)
		}
	})
}

func TestExtractThenFormatRoundTrip(t *testing.T) {
	samples := []string{
		"2026-08-03T08:00:00Z",
		"2026-08-03T08:00:00+00:00",
		"2026-08-03T08:00:00+0800",
		"2026-08-03T08:00:00-0430",
	}
	for _, raw := range samples {
		offset, me := ExtractUtcOffsetLiteral(raw)
		if me != nil {
			t.Fatalf("%q extract: %v", raw, me)
		}
		// 与 Next expandCompactOffset 对齐后再 Parse
		expanded := raw
		if len(raw) >= 1 && (raw[len(raw)-1] == 'z' || raw[len(raw)-1] == 'Z') {
			expanded = raw[:len(raw)-1] + "Z"
		} else if len(raw) >= 5 && raw[len(raw)-3] != ':' {
			// ±HHMM → ±HH:MM
			expanded = raw[:len(raw)-2] + ":" + raw[len(raw)-2:]
		}
		instant, err := time.Parse(time.RFC3339Nano, expanded)
		if err != nil {
			instant, err = time.Parse(time.RFC3339, expanded)
		}
		if err != nil {
			t.Fatalf("%q parse: %v", raw, err)
		}
		formatted, me := FormatHappenedAt(instant, offset)
		if me != nil {
			t.Fatalf("%q format: %v", raw, me)
		}
		if len(formatted) < len(offset) || formatted[len(formatted)-len(offset):] != offset {
			t.Fatalf("%q: formatted %q does not end with %q", raw, formatted, offset)
		}
		got, err := time.Parse(time.RFC3339Nano, formatted)
		if err != nil {
			t.Fatalf("%q reparse: %v", formatted, err)
		}
		if !got.Equal(instant) {
			t.Fatalf("%q instant drift: got %v want %v", raw, got, instant)
		}
	}
}
