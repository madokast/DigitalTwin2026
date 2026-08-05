import { NextRequest, NextResponse } from 'next/server'
import { fetchTagCounts } from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const prefix = request.nextUrl.searchParams.get('prefix') ?? ''
    const tags = await fetchTagCounts(prefix)

    return NextResponse.json({
      success: true,
      tags,
    })
  } catch (error) {
    console.error('Error aggregating tags:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
