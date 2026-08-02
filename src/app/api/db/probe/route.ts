import { NextResponse } from 'next/server'
import { probeDatabase } from '@/lib/dbprobe'

/** POST /api/db/probe — 鉴权由 proxy ApiToken；短命连接探测 */
export async function POST() {
  const result = await probeDatabase()
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result)
}
