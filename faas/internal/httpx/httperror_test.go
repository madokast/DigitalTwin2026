package httpx

import (
	"net/http"
	"testing"
)

// TestStatusTitle 覆盖实际仅用的 6 个已知 status + 未知 status 兜底（docs/20260805-error-response-shape.md「title 映射」）。
func TestStatusTitle(t *testing.T) {
	cases := []struct {
		status int
		want   string
	}{
		{http.StatusBadRequest, "Bad Request"},
		{http.StatusUnauthorized, "Unauthorized"},
		{http.StatusNotFound, "Not Found"},
		{http.StatusConflict, "Conflict"},
		// 413 特例：统一 RFC 9110 新名，覆盖 Go 标准库的 RFC 7231 旧名。
		{http.StatusRequestEntityTooLarge, "Payload Too Large"},
		{http.StatusInternalServerError, "Internal Server Error"},
		{999, ""},
	}
	for _, c := range cases {
		if got := statusTitle(c.status); got != c.want {
			t.Errorf("statusTitle(%d) = %q, want %q", c.status, got, c.want)
		}
	}
}
