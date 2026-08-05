package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 纯 handler 校验：非字符串 from/to 须字段级 400，而非 Invalid JSON body / 500。
func TestHandleRenameTagsTypeMismatch(t *testing.T) {
	t.Parallel()
	s := &Server{} // Pool 未用到：校验失败在 DB 之前返回
	body, _ := json.Marshal(map[string]any{"from": 123, "to": "ok_tag"})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/tags/rename", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	s.handleRenameTags(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["error"] != "missing required fields: from, to" {
		t.Fatalf("error=%q", got["error"])
	}
}
