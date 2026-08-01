package jsonutil

import (
	"encoding/json"
	"testing"
)

func TestDecodeUseNumberRejectsTrailingGarbage(t *testing.T) {
	t.Parallel()
	var dest map[string]any
	if err := DecodeUseNumber([]byte(`{"a":1} xyz`), &dest); err != ErrInvalidJSONBody {
		t.Fatalf("got %v want ErrInvalidJSONBody", err)
	}
}

func TestDecodeUseNumberRejectsSecondJSONValue(t *testing.T) {
	t.Parallel()
	var dest map[string]any
	if err := DecodeUseNumber([]byte(`{"a":1}{"b":2}`), &dest); err != ErrInvalidJSONBody {
		t.Fatalf("got %v want ErrInvalidJSONBody", err)
	}
}

func TestDecodeUseNumberAllowsTrailingWhitespace(t *testing.T) {
	t.Parallel()
	var dest map[string]any
	if err := DecodeUseNumber([]byte("{\"a\":1}\n\t "), &dest); err != nil {
		t.Fatal(err)
	}
	if dest["a"] != json.Number("1") {
		t.Fatalf("a=%v (%T)", dest["a"], dest["a"])
	}
}

func TestDecodeUseNumberRejectsMalformed(t *testing.T) {
	t.Parallel()
	var dest map[string]any
	if err := DecodeUseNumber([]byte(`{`), &dest); err != ErrInvalidJSONBody {
		t.Fatalf("got %v", err)
	}
}
