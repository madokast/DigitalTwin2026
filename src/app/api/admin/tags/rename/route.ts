import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import { isReservedTag, isValidTag, renameTagInTagsJson, reservedTagError } from '@/lib/tags'

interface RenameTagsRequest {
  from?: string
  to?: string
}

export async function POST(request: NextRequest) {
  try {
    const body: RenameTagsRequest = await request.json()
    const from = body.from?.trim()
    const to = body.to?.trim()

    if (!from || !to) {
      return NextResponse.json(
        { error: 'Missing required fields: from, to' },
        { status: 400 },
      )
    }

    if (!isValidTag(from) || !isValidTag(to)) {
      return NextResponse.json(
        { error: 'from and to must be valid tag names' },
        { status: 400 },
      )
    }

    if (isReservedTag(from) || isReservedTag(to)) {
      const bad = isReservedTag(from) ? from : to
      return NextResponse.json({ error: reservedTagError(bad) }, { status: 400 })
    }

    if (from === to) {
      return NextResponse.json(
        { error: 'from and to must be different' },
        { status: 400 },
      )
    }

    const rows = await db.select({ id: records.id, tags: records.tags }).from(records)
    let updated = 0

    for (const row of rows) {
      const nextTags = renameTagInTagsJson(row.tags, from, to)
      if (nextTags === null) continue
      await db.update(records).set({ tags: nextTags }).where(eq(records.id, row.id))
      updated += 1
    }

    return NextResponse.json({
      success: true,
      updated,
    })
  } catch (error) {
    console.error('Error renaming tags:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
