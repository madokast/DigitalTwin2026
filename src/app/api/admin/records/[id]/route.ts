import { NextRequest, NextResponse } from 'next/server'
import { parseRecordDraft } from '@/lib/draft'
import { update } from '@/lib/record'

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

    const result = await update(id, parsed)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({
      success: true,
      record: result.record,
    })
  } catch (error) {
    console.error('Error patching record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
