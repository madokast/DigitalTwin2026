package logapi

import (
	"context"
	"testing"
)

func TestCreateNumberTypeMismatchMessages(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want string
	}{
		{`{"happened_at":123,"value_number":"1","tags":["weight"],"objective_context":"x"}`, "Missing required field: happened_at"},
		{`{"happened_at":"2026-07-30T08:00:00Z","value_number":"1","tags":"x","objective_context":"x"}`, "Missing required field: tags (non-empty array)"},
		{`{"happened_at":"2026-07-30T08:00:00Z","value_number":"1","tags":["weight"],"objective_context":123}`, "Missing required field: objective_context"},
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
	raw := `{"happened_at":"2026-07-30T08:00:00Z","value_text":123,"tags":["study"],"objective_context":"x"}`
	_, status, err := CreateText(context.Background(), nil, []byte(raw))
	if status != 400 || err == nil || err.Error() != "Missing required field: value_text" {
		t.Fatalf("status=%d err=%v", status, err)
	}
}
