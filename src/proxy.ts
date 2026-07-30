import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { unauthorizedResponse, verifyToken } from '@/lib/auth'

/**
 * Next.js 16 Proxy：在进入 Route Handler 之前统一鉴权。
 * matcher 仅匹配 /api/*，页面与静态资源不受影响。
 */
export function proxy(request: NextRequest) {
  if (!verifyToken(request)) {
    return unauthorizedResponse()
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
