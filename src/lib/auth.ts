import 'dotenv/config'
import { NextRequest, NextResponse } from 'next/server'

export function verifyToken(request: NextRequest): boolean {
  const authHeader = request.headers.get('Authorization')
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false
  }
  
  const token = authHeader.slice(7) // 去掉 "Bearer " 前缀
  const expectedToken = process.env.DIGITAL_TWIN_TOKEN
  
  return token === expectedToken
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized: Invalid or missing token' },
    { status: 401 }
  )
}
