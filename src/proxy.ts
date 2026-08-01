import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  unauthorizedResponse,
  verifyAdminAccess,
  verifyApiAccess,
} from '@/lib/auth'

/**
 * Next.js 16 Proxy：在进入 Route Handler 之前统一鉴权。
 * - /api/admin 与 /api/admin/* → 仅 DIGITAL_TWIN_ADMIN_TOKEN
 * - 其它 /api/* → DIGITAL_TWIN_TOKEN 或 DIGITAL_TWIN_ADMIN_TOKEN
 *
 * 框架层差异（见 docs/20260801-api-layering.md §1.1）：
 * - 未导出 method / 未知路径的 405·404 仍用 Next 默认响应，不在此改写成 `{error}` JSON
 *   （Go FC 由 `withJSONErrorPages` 统一 JSON）。
 * - 同源部署不加 CORS；OPTIONS 亦走鉴权。跨域预检仅 FC `withCORS`。
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  // 与 Go httpx 对齐：仅 /api/admin 与 /api/admin/*，避免误伤 /api/administration
  const isAdminRoute =
    path === '/api/admin' || path.startsWith('/api/admin/')
  const ok = isAdminRoute ? verifyAdminAccess(request) : verifyApiAccess(request)

  if (!ok) {
    return unauthorizedResponse()
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
