import { logger } from '@/lib/logger'
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
      return NextResponse.json(
        { error: INVALID_IANA_TZ_ERROR },
        { status: 400 },
      )
    }
    const tz = rawTz === null ? 'UTC' : rawTz
    if (!isValidTimeZone(tz)) {
      return NextResponse.json({ error: INVALID_IANA_TZ_ERROR }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      now: formatNowInZone(new Date(), tz),
      tz,
    })
  } catch (error) {
    logger.error({ err: error }, 'query time')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
