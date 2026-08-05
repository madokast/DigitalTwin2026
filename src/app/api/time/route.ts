import { logger } from '@/lib/logger'
import { errorResponse } from '@/lib/httperror'
import { NextRequest, NextResponse } from 'next/server'
import {
  formatNowInZone,
  INVALID_IANA_TZ_ERROR,
  isValidTimeZone,
} from '@/lib/timeutil'

export async function GET(request: NextRequest) {
  try {
    const rawTz = request.nextUrl.searchParams.get('tz')
    if (rawTz !== null && rawTz === '') {
      return errorResponse(INVALID_IANA_TZ_ERROR, 400)
    }
    const tz = rawTz === null ? 'UTC' : rawTz
    if (!isValidTimeZone(tz)) {
      return errorResponse(INVALID_IANA_TZ_ERROR, 400)
    }

    return NextResponse.json({
      success: true,
      now: formatNowInZone(new Date(), tz),
      tz,
    })
  } catch (error) {
    logger.error({ err: error }, 'query time')
    return errorResponse('Internal server error', 500)
  }
}
