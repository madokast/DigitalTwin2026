import { NextResponse } from 'next/server'
import db from '@/db'
import { records } from '@/db/schema'
import { aggregateTagCounts } from '@/lib/tags'

export async function GET() {
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
