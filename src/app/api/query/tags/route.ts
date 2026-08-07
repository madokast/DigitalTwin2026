import { NextRequest, NextResponse } from 'next/server'
import { routeError } from '@/lib/httperror'
import { queryService } from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const prefix = request.nextUrl.searchParams.get('prefix') ?? ''
    const tags = await queryService.fetchTagCounts(prefix)

    return NextResponse.json({
      success: true,
      tags,
    })
  } catch (error) {
    return routeError(error, 'aggregate tags')
  }
}
