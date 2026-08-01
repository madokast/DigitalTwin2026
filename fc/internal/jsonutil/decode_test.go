package jsonutil_test

import (
	"strings"
	"testing"

	"github.com/mdk/digitaltwin2026/fc/internal/jsonutil"
)

func TestRejectUnknownObjectKeys(t *testing.T) {
	allowed := []string{"a", "b"}
	if err := jsonutil.RejectUnknownObjectKeys([]byte(`{"a":1}`), allowed); err != nil {
		t.Fatal(err)
	}
	err := jsonutil.RejectUnknownObjectKeys([]byte(`{"a":1,"z":9}`), allowed)
	if err == nil || !strings.HasPrefix(err.Error(), jsonutil.UnknownJSONKeyPrefix) {
		t.Fatalf("got %v", err)
	}
	if err.Error() != jsonutil.UnknownJSONKeyPrefix+"z" {
		t.Fatalf("got %q", err.Error())
	}
	err = jsonutil.RejectUnknownObjectKeys([]byte(`[]`), allowed)
	if err != jsonutil.ErrBodyMustBeObject {
		t.Fatalf("got %v", err)
	}
}
