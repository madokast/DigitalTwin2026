package httpx

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// problem+json 响应断言 helper（RFC 9457，docs/20260805-error-response-shape.md）。
// 收敛 server_test.go 等文件里重复的「Unmarshal 响应体 + 断言 detail」样板；
// t.Helper() 使失败定位到真实断言行，且不再 `_ = json.Unmarshal` 吞错。

// parseProblem 解析响应体为 problem+json map；解析失败直接 Fatal。
func parseProblem(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal problem body: %v body %q", err, rr.Body.String())
	}
	return body
}

// assertProblemDetail 断言 detail 精确等于 want。
func assertProblemDetail(t *testing.T, rr *httptest.ResponseRecorder, want string) {
	t.Helper()
	body := parseProblem(t, rr)
	if body["detail"] != want {
		t.Fatalf("detail = %v, want %q (body %s)", body["detail"], want, rr.Body.String())
	}
}

// assertProblemDetailContains 断言 detail 含子串 want。
func assertProblemDetailContains(t *testing.T, rr *httptest.ResponseRecorder, want string) {
	t.Helper()
	detail, ok := parseProblem(t, rr)["detail"].(string)
	if !ok || !strings.Contains(detail, want) {
		t.Fatalf("detail = %q, want contains %q (body %s)", detail, want, rr.Body.String())
	}
}
