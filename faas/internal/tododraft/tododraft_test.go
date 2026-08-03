package tododraft

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tags"
)

type deformFixture struct {
	InputRecord    record.Record  `json:"inputRecord"`
	TodoRecordJSON TodoRecordJSON `json:"todoRecordJson"`
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func TestToTodoRecordJSONSharedFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "testdata", "todo-record-deform.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx deformFixture
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	got := ToTodoRecordJSON(fx.InputRecord)
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(fx.TodoRecordJSON)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("got=%s want=%s", gotJSON, wantJSON)
	}
}

func TestParseTodo(t *testing.T) {
	raw := []byte(`{
		"created_at": "2026-08-02T10:00:00+08:00",
		"content": "Buy milk",
		"objective_context": "weekend grocery list",
		"subjective_interpretation": "need it for breakfast",
		"tags": ["errand"]
	}`)
	got, err := ParseTodo(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.ValueText != "Buy milk" {
		t.Fatalf("content=%q", got.ValueText)
	}
	if len(got.Tags) != 2 || got.Tags[0] != TodoTagInProgress || got.Tags[1] != "errand" {
		t.Fatalf("tags=%v", got.Tags)
	}
	wantInstant := "2026-08-02T02:00:00.000Z"
	if record.FormatHappenedAt(got.HappenedAt) != wantInstant {
		t.Fatalf("happenedAt=%s want %s", record.FormatHappenedAt(got.HappenedAt), wantInstant)
	}
}

func TestParseTodoOmitsTags(t *testing.T) {
	raw := []byte(`{
		"created_at": "2026-08-02T10:00:00+08:00",
		"content": "Buy milk",
		"objective_context": "x"
	}`)
	got, err := ParseTodo(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 1 || got.Tags[0] != TodoTagInProgress {
		t.Fatalf("tags=%v", got.Tags)
	}
}

func TestParseTodoRejects(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{
			`{"content":"x","objective_context":"y"}`,
			"Missing required field: created_at",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","objective_context":"y"}`,
			"Missing required field: content",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"x"}`,
			"Missing required field: objective_context",
		},
		{
			`{"created_at":"2026-08-02T10:00:00","content":"x","objective_context":"y"}`,
			"created_at must be ISO 8601 with timezone (Z or ±HH:MM)",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"x","objective_context":"y","tags":["todo:in_progress"]}`,
			tags.ReservedTagError("todo:in_progress"),
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","happened_at":"2026-08-02T10:00:00+08:00","content":"x","objective_context":"y"}`,
			"Unknown JSON key: happened_at",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"x","objective_context":"y","value_text":"x"}`,
			"Unknown JSON key: value_text",
		},
	}
	for _, tc := range cases {
		_, err := ParseTodo([]byte(tc.raw))
		if err == nil || err.Error() != tc.want {
			t.Fatalf("raw=%s err=%v want=%q", tc.raw, err, tc.want)
		}
	}
}

func TestIsStrictTodoRecordTags(t *testing.T) {
	if !IsStrictTodoRecordTags([]string{TodoTagInProgress, "errand"}) {
		t.Fatal("expected strict todo")
	}
	if IsStrictTodoRecordTags([]string{TodoTagTransition}) {
		t.Fatal("audit must not be strict todo")
	}
	if IsStrictTodoRecordTags([]string{TodoTagInProgress, TodoTagCompleted}) {
		t.Fatal("two states must fail")
	}
	if IsStrictTodoRecordTags([]string{"errand"}) {
		t.Fatal("no state must fail")
	}
}
