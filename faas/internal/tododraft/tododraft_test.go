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

func TestToTodoRecordJSONPreservesOffset(t *testing.T) {
	rec := record.Record{
		ID:               "01900000-0000-7000-8000-000000000003",
		HappenedAt:       "2026-08-02T10:00:00.000+08:00",
		RawContent:       strPtr("Buy milk"),
		Tags:             []string{"todo:in_progress", "errand"},
		ObjectiveContext: "x",
	}
	got := ToTodoRecordJSON(rec)
	if got.CreatedAt != "2026-08-02T10:00:00.000+08:00" {
		t.Fatalf("created_at=%q", got.CreatedAt)
	}
}

func strPtr(s string) *string { return &s }

func TestShouldDeformTodoRecordTagsSharedFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "testdata", "todo-query-deform-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Name   string   `json:"name"`
			Tags   []string `json:"tags"`
			Deform bool     `json:"deform"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Cases {
		got := ShouldDeformTodoRecordTags(c.Tags)
		if got != c.Deform {
			t.Fatalf("%s: got=%v want=%v tags=%v", c.Name, got, c.Deform, c.Tags)
		}
	}
}

func TestParseTodo(t *testing.T) {
	raw := []byte(`{
		"created_at": "2026-08-02T10:00:00+08:00",
		"content": "Buy milk",
		"objective_context": "weekend grocery list",
		"ai_analysis": "need it for breakfast",
		"tags": ["errand"]
	}`)
	got, err := ParseTodo(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.RawContent != "Buy milk" {
		t.Fatalf("content=%q", got.RawContent)
	}
	if len(got.Tags) != 2 || got.Tags[0] != TodoTagInProgress || got.Tags[1] != "errand" {
		t.Fatalf("tags=%v", got.Tags)
	}
	if got.HappenedAtRaw != "2026-08-02T10:00:00+08:00" {
		t.Fatalf("happenedAtRaw=%q", got.HappenedAtRaw)
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
			"missing required field: created_at",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","objective_context":"y"}`,
			"missing required field: content",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"x"}`,
			"missing required field: objective_context",
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
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"x","objective_context":"y","raw_content":"x"}`,
			"Unknown JSON key: raw_content",
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

func TestTodoAuditNotifyTextSharedFixture(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "testdata", "todo-transition-audit.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Target           string `json:"target"`
			TodoID           string `json:"todoId"`
			TodoHappenedAt   string `json:"todoHappenedAt"`
			TodoRawContent   string `json:"todoRawContent"`
			ObjectiveContext string `json:"objective_context"`
			NotifyText       string `json:"notify_text"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Cases {
		got := TodoAuditNotifyText(c.Target, c.TodoID, c.TodoHappenedAt, c.TodoRawContent)
		if got != c.NotifyText {
			t.Fatalf("target=%s notify got=%q want=%q", c.Target, got, c.NotifyText)
		}
		gotObj := AuditObjectiveContext(c.Target, c.TodoID, c.TodoHappenedAt)
		if gotObj != c.ObjectiveContext {
			t.Fatalf("target=%s objective got=%q want=%q", c.Target, gotObj, c.ObjectiveContext)
		}
	}
}

func TestReplaceTodoStateInTags(t *testing.T) {
	got := ReplaceTodoStateInTags([]string{TodoTagInProgress, "errand"}, TodoStateCompleted)
	if len(got) != 2 || got[0] != TodoTagCompleted || got[1] != "errand" {
		t.Fatalf("got=%v", got)
	}
	if !IsTodoAuditRecordTags([]string{TodoTagTransition}) {
		t.Fatal("expected audit")
	}
	if TodoStateFromTags([]string{TodoTagInProgress, "errand"}) != TodoStateInProgress {
		t.Fatal("expected in_progress")
	}
}

func TestParseTodoTransition(t *testing.T) {
	raw := []byte(`{
		"id": "01900000-0000-7000-8000-000000000003",
		"target": "completed",
		"happened_at": "2026-08-02T12:00:00+08:00"
	}`)
	got, err := ParseTodoTransition(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "01900000-0000-7000-8000-000000000003" || got.Target != TodoStateCompleted {
		t.Fatalf("got=%+v", got)
	}
	if got.HappenedAtRaw != "2026-08-02T12:00:00+08:00" {
		t.Fatalf("happenedAtRaw=%q", got.HappenedAtRaw)
	}
}

func TestParseTodoTransitionRejects(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{
			`{"target":"completed","happened_at":"2026-08-02T12:00:00+08:00"}`,
			"missing required field: id",
		},
		{
			`{"id":"01900000-0000-7000-8000-000000000003","happened_at":"2026-08-02T12:00:00+08:00"}`,
			"missing required field: target",
		},
		{
			`{"id":"01900000-0000-7000-8000-000000000003","target":"completed"}`,
			"missing required field: happened_at",
		},
		{
			`{"id":"01900000-0000-7000-8000-000000000003","target":"done","happened_at":"2026-08-02T12:00:00+08:00"}`,
			ErrInvalidTarget.Error(),
		},
		{
			`{"id":"01900000-0000-7000-8000-000000000003","target":"completed","happened_at":"2026-08-02T12:00:00+08:00","created_at":"x"}`,
			"Unknown JSON key: created_at",
		},
	}
	for _, tc := range cases {
		_, err := ParseTodoTransition([]byte(tc.raw))
		if err == nil || err.Error() != tc.want {
			t.Fatalf("raw=%s err=%v want=%q", tc.raw, err, tc.want)
		}
	}
}

func TestParseTodoRejectsDuplicateTags(t *testing.T) {
	raw := []byte(`{
		"created_at": "2026-08-02T10:00:00+08:00",
		"content": "Buy milk",
		"objective_context": "x",
		"tags": ["errand", "errand"]
	}`)
	_, err := ParseTodo(raw)
	if err == nil || err.Error() != `duplicate tag "errand"` {
		t.Fatalf("err: %v", err)
	}
}
