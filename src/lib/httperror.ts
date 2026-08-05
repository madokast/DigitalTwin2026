import http from 'node:http'
import { NextResponse } from 'next/server'

// statusTitle 返回 HTTP 标准 reason phrase。
// Node 标准库 http.STATUS_CODES 已含 RFC 9110 新名（如 413 → "Payload Too Large"），无需 413 特例
// （Go 侧 statusTitle 需特例覆盖 RFC 7231 旧名——见 faas/internal/httpx/httperror.go）。
export function statusTitle(status: number): string {
  return http.STATUS_CODES[status] ?? ''
}

// ErrorResponse RFC 9457 problem+json 错误响应形状（见 docs/20260805-error-response-shape.md）。
// key 顺序 success → title → status → detail，与 Go ProblemResponse 对齐。
export type ErrorResponse = {
  success: false
  title: string
  status: number
  detail: string
}

// errorResponse 组装 problem+json 错误响应（Content-Type: application/problem+json）。
export function errorResponse(
  detail: string,
  status: number,
): NextResponse<ErrorResponse> {
  const body: ErrorResponse = {
    success: false,
    title: statusTitle(status),
    status,
    detail,
  }
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })
}
