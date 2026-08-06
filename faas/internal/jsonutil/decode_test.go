package jsonutil_test

import (
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/jsonutil"
)

func TestRejectUnknownObjectKeys(t *testing.T) {
	allowed := []string{"a", "b"}
	if err := jsonutil.RejectUnknownObjectKeys([]byte(`{"a":1}`), allowed); err != nil {
		t.Fatal(err)
	}
	me := jsonutil.RejectUnknownObjectKeys([]byte(`{"a":1,"z":9}`), allowed)
	if me == nil || !strings.HasPrefix(me.Message, jsonutil.UnknownJSONKeyPrefix) {
		t.Fatalf("got %v", me)
	}
	if me.Message != jsonutil.UnknownJSONKeyPrefix+"z" {
		t.Fatalf("got %q", me.Message)
	}
	me = jsonutil.RejectUnknownObjectKeys([]byte(`[]`), allowed)
	if me == nil || me.Message != jsonutil.ErrBodyMustBeObject {
		t.Fatalf("got %v", me)
	}
}
