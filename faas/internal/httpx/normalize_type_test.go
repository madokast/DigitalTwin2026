package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 纯 handler 校验：from 非数组 / 元素非 string / 空数组须字段级 400，而非 Invalid JSON body / 500。
func TestHandleNormalizeTagsShapeErrors(t *testing.T) {
	t.Parallel()
	s := &Server{} // Pool 未用到：校验失败在 DB 之前返回

	cases := []struct {
		name, body, wantDetail string
	}{
		{"from not array", `{"from": 123, "to": "ok_tag"}`, "from must be an array of strings"},
		{"from element not string", `{"from": ["a", 1], "to": "ok_tag"}`, "from must be an array of strings"},
		{"empty from", `{"from": [], "to": "ok_tag"}`, "missing required field: from"},
		{"missing to", `{"from": ["a"], "to": null}`, "missing required field: to"},
		{"to in from", `{"from": ["a", "ok_tag"], "to": "ok_tag"}`, "to must not be in from"},
		{"duplicate from", `{"from": ["a", "a"], "to": "b"}`, `duplicate tag in from: "a"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/admin/tags/normalize", bytes.NewReader([]byte(c.body)))
			rr := httptest.NewRecorder()
			s.handleNormalizeTags(rr, req)
			if rr.Code != 400 {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			var got map[string]any
			if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got["detail"] != c.wantDetail {
				t.Fatalf("error=%q want %q", got["detail"], c.wantDetail)
			}
		})
	}
}
