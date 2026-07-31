import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'
import { parseRecordDraft } from '@/lib/record-draft'

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!id) {
      return NextResponse.json({ error: 'Missing record id' }, { status: 400 })
    }

    const body = await request.json()
    const parsed = parseRecordDraft(body)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const result = await db
      .update(records)
      .set({
        happenedAt: parsed.happenedAt,
        valueNumber: parsed.valueNumber,
        valueText: parsed.valueText,
        tags: JSON.stringify(parsed.tags),
        objectiveContext: parsed.objectiveContext,
        subjectiveInterpretation: parsed.subjectiveInterpretation,
      })
      .where(eq(records.id, id))
      .returning()

    if (result.length === 0) {
      return NextResponse.json({ error: 'Record not found' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      record: result[0],
    })
  } catch (error) {
    console.error('Error patching record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
