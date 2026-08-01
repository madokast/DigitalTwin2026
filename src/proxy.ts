import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import {
  unauthorizedResponse,
  verifyAdminAccess,
  verifyApiAccess,
} from '@/lib/auth'

/**
 * Next.js 16 Proxy：在进入 Route Handler 之前统一鉴权。
 * - /api/admin/* → 仅 DIGITAL_TWIN_ADMIN_TOKEN
 * - 其它 /api/* → DIGITAL_TWIN_TOKEN 或 DIGITAL_TWIN_ADMIN_TOKEN
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
