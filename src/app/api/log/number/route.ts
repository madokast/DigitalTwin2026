import { NextRequest, NextResponse } from 'next/server'
import { createNumber } from '@/lib/logapi'
import { notifyRecordInserted } from '@/lib/telegram'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const result = await createNumber(body)
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
    console.error('Error creating number record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
