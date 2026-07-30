import { NextRequest, NextResponse } from 'next/server'
import db from '@/db'
import { records } from '@/db/schema'
import { verifyToken, unauthorizedResponse } from '@/lib/auth'
import { aggregateTagCounts } from '@/lib/tags'

export async function GET(request: NextRequest) {
  if (!verifyToken(request)) {
    return unauthorizedResponse()
  }

  try {
    const rows = await db.select({ tags: records.tags }).from(records)
    const tags = aggregateTagCounts(rows.map((row) => row.tags))

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
