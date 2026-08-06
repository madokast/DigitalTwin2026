package myerr

import (
	"errors"
	"strings"
	"testing"
)

func TestConstructors(t *testing.T) {
	cases := []struct {
		name   string
		got    *MyError
		status int
		msg    string
	}{
		{"notfound", NewNotFound("record not found"), 404, "record not found"},
		{"validation", NewValidation("missing required field: memo"), 400, "missing required field: memo"},
		{"conflict", NewConflict("duplicate"), 409, "duplicate"},
	}
	for _, c := range cases {
		if c.got.Status != c.status {
			t.Fatalf("%s: status %d", c.name, c.got.Status)
		}
		if c.got.Message != c.msg || c.got.Error() != c.msg {
			t.Fatalf("%s: message %q", c.name, c.got.Message)
		}
	}
}

func TestNewInternalDescribe(t *testing.T) {
	// 驱动错误：类型名 + 消息
	err := errors.New(`ERROR: relation "records" does not exist (SQLSTATE 42P01)`)
	me := NewInternal(err)
	if me.Status != 500 {
		t.Fatalf("status %d", me.Status)
	}
	wantPrefix := "*errors.errorString: "
	if !strings.HasPrefix(me.Message, wantPrefix) {
		t.Fatalf("describe missing type prefix: %q", me.Message)
	}
	if !strings.Contains(me.Message, `ERROR: relation "records" does not exist (SQLSTATE 42P01)`) {
		t.Fatalf("driver message not embedded: %q", me.Message)
	}
}

func TestNewInternalEmptyMessage(t *testing.T) {
	// 空消息兜底：仅类型名，永不为空
	me := NewInternal(errors.New(""))
	if me.Message != "*errors.errorString" {
		t.Fatalf("empty fallback: %q", me.Message)
	}
}
