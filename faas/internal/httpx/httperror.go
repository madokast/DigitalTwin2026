package httpx

import "net/http"

// ProblemResponse RFC 9457 problem+json 错误响应（见 docs/20260805-error-response-shape.md）。
// 字段声明顺序 = JSON key 顺序（success 恒第一，符合 go-code-quality.md §2 模板）。
// S2 切换 writeError 时替换 responses.go 的旧 ErrorResponse。
type ProblemResponse struct {
	Success bool   `json:"success"`
	Title   string `json:"title"`
	Status  int    `json:"status"`
	Detail  string `json:"detail"`
}

// statusTitle 返回 HTTP 标准 reason phrase。
// 413 特例：Go 标准库 StatusText 返回 RFC 7231 旧名 "Request Entity Too Large"，
// Node 标准库返回 RFC 9110 新名 "Payload Too Large"——双端统一新名（单点隔离，其余依赖标准库）。
func statusTitle(status int) string {
	if status == http.StatusRequestEntityTooLarge {
		return "Payload Too Large"
	}
	return http.StatusText(status)
}
