import { NextResponse } from 'next/server'
import { errorResponse } from '@/lib/httperror'
import { probeDatabase } from '@/lib/dbprobe'

/** POST /api/db/probe — 鉴权由 proxy ApiToken；短命连接探测 */
export async function POST() {
  const result = await probeDatabase()
  if ('error' in result) {
    return errorResponse(result.error.message, result.error.status)
  }
  return NextResponse.json(result)
}
