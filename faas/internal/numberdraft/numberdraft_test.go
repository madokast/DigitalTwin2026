package numberdraft

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestParseNumberBatchSingleEntry(t *testing.T) {
	got, err := ParseNumberBatch([]byte(`{
		"happened_at":"2026-08-05T10:00:00+08:00",
		"entries":[{"numeric_value":"36.8","memo":"axillary temperature"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if !got.HappenedAt.Equal(time.Date(2026, 8, 5, 2, 0, 0, 0, time.UTC)) {
		t.Fatalf("happenedAt: %v", got.HappenedAt)
	}
	if got.UtcOffset != "+08:00" {
		t.Fatalf("utcOffset: %q", got.UtcOffset)
	}
	if len(got.Entries) != 1 {
		t.Fatalf("entries: %d", len(got.Entries))
	}
	want := NormalizedNumberEntry{
		NumericValue:     "36.8",
		ObjectiveContext: "axillary temperature",
		Tags:             []string{},
		AiAnalysis:       nil,
	}
	if !reflect.DeepEqual(got.Entries[0], want) {
		t.Fatalf("entry:\n got %#v\nwant %#v", got.Entries[0], want)
	}
}

func TestParseNumberBatchMultipleWithTagsAndAi(t *testing.T) {
	got, err := ParseNumberBatch([]byte(`{
		"happened_at":"2026-08-05T10:00:00+08:00",
		"entries":[
			{"numeric_value":"36.8","memo":"first","tags":["vitals"]},
			{"numeric_value":"75.5","memo":"second","ai_analysis":"a bit heavy"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Entries) != 2 {
		t.Fatalf("entries: %d", len(got.Entries))
	}
	if !reflect.DeepEqual(got.Entries[0].Tags, []string{"vitals"}) {
		t.Fatalf("tags[0]: %v", got.Entries[0].Tags)
	}
	if got.Entries[0].AiAnalysis != nil {
		t.Fatalf("ai[0] should be nil")
	}
	if len(got.Entries[1].Tags) != 0 {
		t.Fatalf("tags[1]: %v", got.Entries[1].Tags)
	}
	if got.Entries[1].AiAnalysis == nil || *got.Entries[1].AiAnalysis != "a bit heavy" {
		t.Fatalf("ai[1]: %v", got.Entries[1].AiAnalysis)
	}
}

func TestParseNumberBatchErrors(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{
			"missing happened_at",
			`{"entries":[{"numeric_value":"1","memo":"x"}]}`,
			"missing required field: happened_at",
		},
		{
			"unknown top-level key",
			`{"happened_at":"2026-08-05T10:00:00+08:00","type":"expense","entries":[{"numeric_value":"1","memo":"x"}]}`,
			"Unknown JSON key: type",
		},
		{
			"missing entries",
			`{"happened_at":"2026-08-05T10:00:00+08:00"}`,
			"missing required field: entries (non-empty array)",
		},
		{
			"empty entries",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[]}`,
			"entries must be a non-empty array",
		},
		{
			"non-object entry",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":["x"]}`,
			"entries[0] must be an object",
		},
		{
			"unknown entry key",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1","memo":"x","foo":1}]}`,
			"entries[0]: Unknown JSON key: foo",
		},
		{
			"missing numeric_value",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"memo":"x"}]}`,
			"entries[0]: missing required field: numeric_value",
		},
		{
			"null numeric_value",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":null,"memo":"x"}]}`,
			"entries[0]: missing required field: numeric_value",
		},
		{
			"json number numeric_value",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":36.8,"memo":"x"}]}`,
			"entries[0]: numeric_value must be a decimal string",
		},
		{
			"invalid decimal numeric_value",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1e3","memo":"x"}]}`,
			"entries[0]: invalid numeric_value",
		},
		{
			"missing memo",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1"}]}`,
			"entries[0]: missing required field: memo",
		},
		{
			"blank memo",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1","memo":"   "}]}`,
			"entries[0]: memo must not be blank",
		},
		{
			"invalid tag",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1","memo":"x","tags":["体重"]}]}`,
			`entries[0]: invalid tag: "体重". Tags must contain only letters, numbers, underscores, and cannot start with a number`,
		},
		{
			"reserved tag",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1","memo":"x","tags":["body:weight"]}]}`,
			`entries[0]: tag "body:weight" is reserved; use the dedicated log API for this record type`,
		},
		{
			"blank ai_analysis",
			`{"happened_at":"2026-08-05T10:00:00+08:00","entries":[{"numeric_value":"1","memo":"x","ai_analysis":"   "}]}`,
			"entries[0]: ai_analysis must not be blank",
		},
	}
	for _, c := range cases {
		_, err := ParseNumberBatch([]byte(c.raw))
		if err == nil || err.Error() != c.want {
			t.Fatalf("%s: got %v want %q", c.name, err, c.want)
		}
	}
}

func TestParseNumberBatchOversized(t *testing.T) {
	entries := make([]map[string]any, 0, MaxNumberEntries+1)
	for i := 0; i < MaxNumberEntries+1; i++ {
		entries = append(entries, map[string]any{"numeric_value": "1", "memo": "x"})
	}
	body := map[string]any{
		"happened_at": "2026-08-05T10:00:00+08:00",
		"entries":     entries,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ParseNumberBatch(raw)
	if err == nil || err.Error() != "entries must contain at most 100 items" {
		t.Fatalf("oversized: got %v", err)
	}
}

func TestParseNumberBatchTrimsMemo(t *testing.T) {
	got, err := ParseNumberBatch([]byte(`{
		"happened_at":"2026-08-05T10:00:00+08:00",
		"entries":[{"numeric_value":"1","memo":"  axillary temperature  "}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if got.Entries[0].ObjectiveContext != "axillary temperature" {
		t.Fatalf("objectiveContext: %q", got.Entries[0].ObjectiveContext)
	}
}

func TestParseNumberBatchNullTags(t *testing.T) {
	got, err := ParseNumberBatch([]byte(`{
		"happened_at":"2026-08-05T10:00:00+08:00",
		"entries":[{"numeric_value":"1","memo":"x","tags":null}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Entries[0].Tags) != 0 {
		t.Fatalf("null tags should normalize to empty, got %v", got.Entries[0].Tags)
	}
}

func TestParseNumberBatchDuplicateTags(t *testing.T) {
	_, err := ParseNumberBatch([]byte(`{
		"happened_at":"2026-08-05T10:00:00+08:00",
		"entries":[{"numeric_value":"1","memo":"x","tags":["a","b","a"]}]
	}`))
	if err == nil || err.Error() != `entries[0]: duplicate tag "a"` {
		t.Fatalf("err: %v", err)
	}
}
