package reviewdraft

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type cadenceCases struct {
	Cadences       []string `json:"cadences"`
	MissingMessage string   `json:"missing_message"`
	InvalidMessage string   `json:"invalid_message"`
	Missing        []any    `json:"missing"`
	Invalid        []string `json:"invalid"`
}

func loadCadenceCases(t *testing.T) cadenceCases {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	b, err := os.ReadFile(filepath.Join(root, "testdata", "review-cadence-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases cadenceCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func validReview() []byte {
	return []byte(`{
		"happened_at":"2026-08-09T19:00:00+08:00",
		"cadence":"weekly",
		"raw_content":"This week I slept better and finished the report.",
		"objective_context":"Weekly review covering 2026-08-03..2026-08-09",
		"ai_analysis":"Deeper work in the morning helped.",
		"tags":["work"]
	}`)
}

func TestCadenceFixtures(t *testing.T) {
	cases := loadCadenceCases(t)
	if len(cadences) != len(cases.Cadences) {
		t.Fatalf("cadence list mismatch")
	}
	for _, c := range cadences {
		found := false
		for _, want := range cases.Cadences {
			if c == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("cadence %q not in fixture", c)
		}
	}
	if ErrMissingCadenceMessage != cases.MissingMessage || ErrInvalidCadenceMessage != cases.InvalidMessage {
		t.Fatalf("message mismatch: missing=%q invalid=%q", ErrMissingCadenceMessage, ErrInvalidCadenceMessage)
	}

	for _, raw := range cases.Missing {
		body := map[string]any{
			"happened_at":       "2026-08-09T19:00:00+08:00",
			"cadence":           raw,
			"raw_content":       "x",
			"objective_context": "ctx",
		}
		b, _ := json.Marshal(body)
		_, err := ParseReview(b)
		if err == nil || err.Error() != ErrMissingCadenceMessage {
			t.Fatalf("missing %#v: got %v", raw, err)
		}
	}
	for _, raw := range cases.Invalid {
		body := map[string]any{
			"happened_at":       "2026-08-09T19:00:00+08:00",
			"cadence":           raw,
			"raw_content":       "x",
			"objective_context": "ctx",
		}
		b, _ := json.Marshal(body)
		_, err := ParseReview(b)
		if err == nil || err.Error() != ErrInvalidCadenceMessage {
			t.Fatalf("invalid %q: got %v", raw, err)
		}
	}
}

func TestParseReviewValid(t *testing.T) {
	got, err := ParseReview(validReview())
	if err != nil {
		t.Fatal(err)
	}
	if got.Cadence != "weekly" || got.HappenedAtRaw == "" {
		t.Fatalf("cadence/happenedAtRaw: %+v", got)
	}
	if got.RawContent != "This week I slept better and finished the report." {
		t.Fatalf("rawContent: %q", got.RawContent)
	}
	if got.ObjectiveContext != "Weekly review covering 2026-08-03..2026-08-09" {
		t.Fatalf("objective: %q", got.ObjectiveContext)
	}
	if got.AiAnalysis == nil || *got.AiAnalysis != "Deeper work in the morning helped." {
		t.Fatalf("aiAnalysis: %#v", got.AiAnalysis)
	}
	if len(got.Tags) != 1 || got.Tags[0] != "work" {
		t.Fatalf("tags: %#v", got.Tags)
	}
}

func TestParseReviewOptionalFields(t *testing.T) {
	body := map[string]any{
		"happened_at":       "2026-08-09T19:00:00+08:00",
		"cadence":           "yearly",
		"raw_content":       "  text  ",
		"objective_context": " ctx ",
	}
	b, _ := json.Marshal(body)
	got, err := ParseReview(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 0 || got.AiAnalysis != nil {
		t.Fatalf("optional fields: tags=%#v ai=%#v", got.Tags, got.AiAnalysis)
	}
	if got.RawContent != "text" || got.ObjectiveContext != "ctx" {
		t.Fatalf("trim: %q %q", got.RawContent, got.ObjectiveContext)
	}
}

func TestParseReviewRejectsBlank(t *testing.T) {
	cases := []struct {
		key, value, want string
	}{
		{"raw_content", "", "missing required field: raw_content"},
		{"raw_content", "   ", "raw_content must not be blank"},
		{"objective_context", "", "missing required field: objective_context"},
		{"objective_context", "   ", "objective_context must not be blank"},
		{"ai_analysis", "   ", "ai_analysis must not be blank"},
	}
	for _, tc := range cases {
		body := map[string]any{
			"happened_at":       "2026-08-09T19:00:00+08:00",
			"cadence":           "weekly",
			"raw_content":       "x",
			"objective_context": "ctx",
			tc.key:              tc.value,
		}
		b, _ := json.Marshal(body)
		_, err := ParseReview(b)
		if err == nil || err.Error() != tc.want {
			t.Fatalf("%s=%q: got %v want %q", tc.key, tc.value, err, tc.want)
		}
	}
}

func TestParseReviewRejectsUnknownKeys(t *testing.T) {
	for _, key := range []string{"numeric_value", "utc_offset"} {
		body := map[string]any{
			"happened_at":       "2026-08-09T19:00:00+08:00",
			"cadence":           "weekly",
			"raw_content":       "x",
			"objective_context": "ctx",
			key:                 "1",
		}
		b, _ := json.Marshal(body)
		_, err := ParseReview(b)
		if err == nil || err.Error() != "Unknown JSON key: "+key {
			t.Fatalf("%s: got %v", key, err)
		}
	}
}

func TestParseReviewRejectsReservedTag(t *testing.T) {
	for _, tag := range []string{"review", "review:weekly"} {
		body := map[string]any{
			"happened_at":       "2026-08-09T19:00:00+08:00",
			"cadence":           "weekly",
			"raw_content":       "x",
			"objective_context": "ctx",
			"tags":              []string{tag},
		}
		b, _ := json.Marshal(body)
		_, err := ParseReview(b)
		if err == nil || err.Error() == "" {
			t.Fatalf("%s: expected reserved rejection", tag)
		}
	}
}

func TestReviewTagsForCadence(t *testing.T) {
	got := ReviewTagsForCadence("weekly", []string{"work", "sleep"})
	if len(got) != 3 || got[0] != "review:weekly" || got[1] != "work" || got[2] != "sleep" {
		t.Fatalf("got %#v", got)
	}
	if got := ReviewTagsForCadence("semiannually", nil); len(got) != 1 || got[0] != "review:semiannually" {
		t.Fatalf("nil tags: %#v", got)
	}
}

func TestParseReviewRejectsDuplicateTags(t *testing.T) {
	raw := []byte(`{
		"happened_at": "2026-08-09T19:00:00+08:00",
		"cadence": "weekly",
		"raw_content": "weekly review",
		"objective_context": "ctx",
		"tags": ["work", "work"]
	}`)
	_, err := ParseReview(raw)
	if err == nil || err.Error() != `duplicate tag "work"` {
		t.Fatalf("err: %v", err)
	}
}
