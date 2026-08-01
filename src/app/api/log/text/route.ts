import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/httpjson'
import { createText, type TextBody } from '@/lib/logapi'
import { notifyRecordInserted } from '@/lib/telegram'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    const result = await createText(parsed.value as TextBody)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    // 仅 INSERT 成功后 best-effort 通知；失败不影响 201
    await notifyRecordInserted(result.record)

    return NextResponse.json(
      { success: true, record: result.record },
      { status: result.status },
    )
  } catch (error) {
    console.error('Error creating text record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
