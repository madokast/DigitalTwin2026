import { NextRequest, NextResponse } from 'next/server'
import { and, count, gte, lt } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import { getZonedDayBounds, isValidTimeZone } from '@/lib/time'

export async function GET(request: NextRequest) {
  try {
    const tz = request.nextUrl.searchParams.get('tz')
    if (!tz || !isValidTimeZone(tz)) {
      return NextResponse.json(
        { error: 'Query parameter tz must be a valid IANA time zone' },
        { status: 400 },
      )
    }

    const { start, end } = getZonedDayBounds(new Date(), tz)

    const [totalRow] = await db.select({ value: count() }).from(records)
    const [todayRow] = await db
      .select({ value: count() })
      .from(records)
      .where(and(gte(records.happenedAt, start), lt(records.happenedAt, end)))

    return NextResponse.json({
      success: true,
      total: Number(totalRow?.value ?? 0),
      today: Number(todayRow?.value ?? 0),
      tz,
    })
  } catch (error) {
    console.error('Error querying summary:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
