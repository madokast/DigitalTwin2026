import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/httpjson'
import { createNumberBatch } from '@/lib/logapi'
import {
  notifyNumberBatchInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    const result = await createNumberBatch(parsed.value)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    // 响应写出后再通知（整批一条摘要），避免渠道阻塞 201；失败不影响已成功写入
    scheduleBestEffortNotify(() => notifyNumberBatchInserted(result.records))

    return NextResponse.json(
      {
        success: true,
        inserted: result.inserted,
        atomic: true,
      },
      { status: result.status },
    )
  } catch (error) {
    console.error('Error creating number records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
