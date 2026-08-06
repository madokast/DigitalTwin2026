import http from 'node:http'
import { NextResponse } from 'next/server'
import { logger } from './logger'
import { MyError, newInternal } from './myerr'

// statusTitle 返回 HTTP 标准 reason phrase。
// Node 标准库 http.STATUS_CODES 已含 RFC 9110 新名（如 413 → "Payload Too Large"），无需 413 特例
// （Go 侧 statusTitle 需特例覆盖 RFC 7231 旧名——见 faas/internal/httpx/httperror.go）。
//
// 未知 status 返回空串（STATUS_CODES 无对应项，`?? ''`）——这是有意的哨兵设计（见
// docs/20260805-rfc9457-followups.md D1）：本系统只用已知 status 集（单测覆盖），
// 空 title 用于暴露「传入非预期 status」的编码错误，勿在此加 fallback 文案掩盖。
export function statusTitle(status: number): string {
  return http.STATUS_CODES[status] ?? ''
}

// ErrorResponse RFC 9457 problem+json 错误响应形状（见 docs/20260805-error-response-shape.md）。
// key 顺序 success → title → status → detail，与 Go ErrorResponse struct 对齐。
export type ErrorResponse = {
  success: false
  title: string
  status: number
  detail: string
}

// errorMessage：任意捕获值 → detail 字符串（与 Go errorDetail 对称，见
// docs/20260806-internal-error-transparency.md §3.5）。Error → message；非 Error → String()。
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

// routeError route catch 统一错误出口（决策 D，与 Go httpx.writeErr 同构）。
// MyError → 按 status 分级日志（>=500 error，<500 info）+ 原样响应；
// 非 MyError（漏包装）→ 500 兜底（describe 类型名 + 消息）。
export function routeError(
  error: unknown,
  logMsg: string,
): NextResponse<ErrorResponse> {
  if (error instanceof MyError) {
    if (error.status >= 500) {
      logger.error({ err: error }, logMsg)
    } else {
      logger.info({ err: error }, logMsg)
    }
    return errorResponse(error.message, error.status)
  }
  logger.error({ err: error }, logMsg)
  return errorResponse(newInternal(error).message, 500)
}
