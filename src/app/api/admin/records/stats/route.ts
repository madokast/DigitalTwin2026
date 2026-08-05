import { NextRequest, NextResponse } from 'next/server'
import { fetchSummary } from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const tz = request.nextUrl.searchParams.get('tz') ?? ''
    const result = await fetchSummary(tz)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      total: result.total,
      today: result.today,
      tz: result.tz,
    })
  } catch (error) {
    console.error('Error querying summary:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
