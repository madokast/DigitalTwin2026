package httpx

import "net/http"

// ErrorResponse RFC 9457 problem+json 错误响应（见 docs/20260805-error-response-shape.md）。
// 与 Node 侧 `ErrorResponse` type 同名（双端 stem 对齐，AGENTS.md「双端同构」），
// 与 OpenAPI `Error` schema 呼应。
// 字段声明顺序 = JSON key 顺序（success 恒第一，符合 go-code-quality.md §2 模板）。
type ErrorResponse struct {
	Success bool   `json:"success"`
	Title   string `json:"title"`
	Status  int    `json:"status"`
	Detail  string `json:"detail"`
}

// statusTitle 返回 HTTP 标准 reason phrase。
// 413 特例：Go 标准库 StatusText 返回 RFC 7231 旧名 "Request Entity Too Large"，
// Node 标准库返回 RFC 9110 新名 "Payload Too Large"——双端统一新名（单点隔离，其余依赖标准库）。
//
// 未知 status 返回空串（StatusText 无对应项）——这是有意的哨兵设计（见
// docs/20260805-rfc9457-followups.md D1）：本系统只用已知 status 集（单测覆盖），
// 空 title 用于暴露「传入非预期 status」的编码错误，勿在此加 fallback 文案掩盖。
func statusTitle(status int) string {
	if status == http.StatusRequestEntityTooLarge {
		return "Payload Too Large"
	}
	return http.StatusText(status)
}
