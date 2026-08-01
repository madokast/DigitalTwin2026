import { NextRequest, NextResponse } from 'next/server'
import { parseRecordDraft, type RecordDraftBody } from '@/lib/draft'
import { readJsonBody } from '@/lib/httpjson'
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

    const parsedJson = await readJsonBody(request)
    if (!parsedJson.ok) {
      return NextResponse.json(
        { error: parsedJson.error },
        { status: parsedJson.status },
      )
    }

    const parsed = parseRecordDraft(parsedJson.value as RecordDraftBody)
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
