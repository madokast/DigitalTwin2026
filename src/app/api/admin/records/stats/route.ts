import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { errorMessage, errorResponse } from '@/lib/httperror'
import { fetchSummary } from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const tz = request.nextUrl.searchParams.get('tz') ?? ''
    const result = await fetchSummary(tz)
    if ('error' in result) {
      return errorResponse(result.error, 400)
    }

    return NextResponse.json({
      success: true,
      total: result.total,
      today: result.today,
      tz: result.tz,
    })
  } catch (error) {
    logger.error({ err: error }, 'query summary')
    return errorResponse(errorMessage(error), 500)
  }
}
