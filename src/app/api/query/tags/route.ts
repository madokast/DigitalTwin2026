import { NextRequest, NextResponse } from 'next/server'
import { routeError } from '@/lib/httperror'
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
    return routeError(error, 'aggregate tags')
  }
}
