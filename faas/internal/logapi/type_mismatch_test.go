package logapi

import (
	"context"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

func TestCreateNumberTypeMismatchMessages(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want string
	}{
		{`{"happened_at":123,"numeric_value":"1","tags":["weight"],"objective_context":"x"}`, "Missing required field: happened_at"},
		{`{"happened_at":"2026-07-30T08:00:00Z","numeric_value":"1","tags":"x","objective_context":"x"}`, "Missing required field: tags (non-empty array)"},
		{`{"happened_at":"2026-07-30T08:00:00Z","numeric_value":"1","tags":["weight"],"objective_context":123}`, "Missing required field: objective_context"},
	}
	for _, c := range cases {
		_, status, err := CreateNumber(context.Background(), nil, []byte(c.raw))
		if status != 400 || err == nil || err.Error() != c.want {
			t.Fatalf("%s: status=%d err=%v want %q", c.raw, status, err, c.want)
		}
	}
}

func TestCreateTextTypeMismatchMessages(t *testing.T) {
	t.Parallel()
	raw := `{"happened_at":"2026-07-30T08:00:00Z","raw_content":123,"tags":["study"],"objective_context":"x"}`
	_, status, err := CreateText(context.Background(), nil, []byte(raw))
	if status != 400 || err == nil || err.Error() != "Missing required field: raw_content" {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

func TestCreateBodyWeightRejectsJSONNumber(t *testing.T) {
	t.Parallel()
	raw := []byte(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": 75.5,
		"objective_context": "x"
	}`)
	_, status, err := CreateBodyWeight(context.Background(), nil, raw)
	if status != 400 || err == nil || err.Error() != "numeric_value must be a decimal string" {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

func TestCreateTodoRejects(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want string
	}{
		{
			`{"content":"Buy milk","objective_context":"x"}`,
			"Missing required field: created_at",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"Buy milk","objective_context":"x","tags":["todo:in_progress"]}`,
			`tag "todo:in_progress" is reserved; use POST /api/log/todo for to-do entries`,
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","happened_at":"2026-08-02T10:00:00+08:00","content":"Buy milk","objective_context":"x"}`,
			"Unknown JSON key: happened_at",
		},
	}
	for _, c := range cases {
		_, status, err := CreateTodo(context.Background(), nil, []byte(c.raw))
		if status != 400 || err == nil || err.Error() != c.want {
			t.Fatalf("%s: status=%d err=%v want %q", c.raw, status, err, c.want)
		}
	}
}

func TestTransitionTodoRejectsValidation(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want string
	}{
		{
			`{"target":"completed","happened_at":"2026-08-02T12:00:00+08:00"}`,
			"Missing required field: id",
		},
		{
			`{"id":"01900000-0000-7000-8000-000000000003","target":"done","happened_at":"2026-08-02T12:00:00+08:00"}`,
			tododraft.ErrInvalidTarget,
		},
		{
			`{"id":"01900000-0000-7000-8000-000000000003","target":"completed","happened_at":"2026-08-02T12:00:00+08:00","created_at":"x"}`,
			"Unknown JSON key: created_at",
		},
		{
			`{"id":"not-a-uuid","target":"completed","happened_at":"2026-08-02T12:00:00+08:00"}`,
			record.InvalidID.Error(),
		},
	}
	for _, c := range cases {
		_, status, err := TransitionTodo(context.Background(), nil, []byte(c.raw))
		if status != 400 || err == nil || err.Error() != c.want {
			t.Fatalf("%s: status=%d err=%v want %q", c.raw, status, err, c.want)
		}
	}
}

func TestCreateNumberRejectsBodyWeightTag(t *testing.T) {
	t.Parallel()
	raw := []byte(`{
		"happened_at": "2026-08-01T12:30:00+08:00",
		"numeric_value": "1",
		"tags": ["body:weight"],
		"objective_context": "x"
	}`)
	_, status, err := CreateNumber(context.Background(), nil, raw)
	if status != 400 {
		t.Fatalf("status %d", status)
	}
	want := `tag "body:weight" is reserved; use POST /api/log/body/weight for body weight entries`
	if err == nil || err.Error() != want {
		t.Fatalf("err=%v", err)
	}
}
