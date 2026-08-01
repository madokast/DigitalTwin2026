import 'dotenv/config'
import { NextRequest, NextResponse } from 'next/server'

function getBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }
  // 与 Go auth.BearerToken 一致：TrimSpace，避免尾随/多余空格导致双端 401 vs 200
  const token = authHeader.slice('Bearer '.length).trim()
  return token === '' ? null : token
}

function isConfiguredToken(token: string, expected: string | undefined): boolean {
  return Boolean(expected) && token === expected
}

/** 普通 API：AI token 或 admin token 均可 */
export function verifyApiAccess(request: NextRequest): boolean {
  const token = getBearerToken(request)
  if (!token) return false
  return (
    isConfiguredToken(token, process.env.DIGITAL_TWIN_TOKEN) ||
    isConfiguredToken(token, process.env.DIGITAL_TWIN_ADMIN_TOKEN)
  )
}

/** Admin API：仅 admin token */
export function verifyAdminAccess(request: NextRequest): boolean {
  const token = getBearerToken(request)
  if (!token) return false
  return isConfiguredToken(token, process.env.DIGITAL_TWIN_ADMIN_TOKEN)
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized: Invalid or missing token' },
    { status: 401 },
  )
}
