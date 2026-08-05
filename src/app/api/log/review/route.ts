import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/httpjson'
import { createReview } from '@/lib/logapi'
import {
  notifyRecordInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    const result = await createReview(parsed.value)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    // 响应写出后再通知，避免渠道阻塞 201；失败不影响已成功写入
    scheduleBestEffortNotify(() => notifyRecordInserted(result.record))

    return NextResponse.json(
      { success: true, record: result.record },
      { status: result.status },
    )
  } catch (error) {
    logger.error({ err: error }, 'Error creating review record')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
