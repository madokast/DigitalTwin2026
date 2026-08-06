package logapi

import (
	"context"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/bodyweightdraft"
	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/record"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

func TestCreateTextTypeMismatchMessages(t *testing.T) {
	t.Parallel()
	raw := `{"happened_at":"2026-07-30T08:00:00Z","raw_content":123,"tags":["study"],"objective_context":"x"}`
	body, err := ParseTextBody([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	_, err = CreateText(context.Background(), nil, body)
	assertMyStatus(t, err, 400)
	if err.Message != "missing required field: raw_content" {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateBodyWeightRejectsJSONNumber(t *testing.T) {
	t.Parallel()
	raw := []byte(`{
		"happened_at": "2026-08-02T08:00:00+08:00",
		"numeric_value": 75.5,
		"objective_context": "x"
	}`)
	_, err := bodyweightdraft.ParseBodyWeight(raw)
	if err == nil || err.Message != "numeric_value must be a decimal string" {
		t.Fatalf("err=%v", err)
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
			"missing required field: created_at",
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","content":"Buy milk","objective_context":"x","tags":["todo:in_progress"]}`,
			`tag "todo:in_progress" is reserved; use the dedicated log API for this record type`,
		},
		{
			`{"created_at":"2026-08-02T10:00:00+08:00","happened_at":"2026-08-02T10:00:00+08:00","content":"Buy milk","objective_context":"x"}`,
			"Unknown JSON key: happened_at",
		},
	}
	for _, c := range cases {
		_, err := tododraft.ParseTodo([]byte(c.raw))
		if err == nil || err.Message != c.want {
			t.Fatalf("%s: err=%v want %q", c.raw, err, c.want)
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
			"missing required field: id",
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
			record.ErrInvalidID,
		},
	}
	for _, c := range cases {
		var me *myerr.MyError
		if c.want == record.ErrInvalidID {
			parsed, perr := tododraft.ParseTodoTransition([]byte(c.raw))
			if perr != nil {
				t.Fatalf("%s: parse: %v", c.raw, perr)
			}
			_, me = TransitionTodo(context.Background(), nil, parsed)
			assertMyStatus(t, me, 400)
		} else {
			// route 层 draft 解析错误（myerr 400），直接断言文案
			_, me = tododraft.ParseTodoTransition([]byte(c.raw))
		}
		if me == nil || me.Message != c.want {
			t.Fatalf("%s: err=%v want %q", c.raw, me, c.want)
		}
	}
}
