import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { errorMessage, errorResponse } from '@/lib/httperror'
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
      return errorResponse(parsed.error, parsed.status)
    }

    const result = await createNumberBatch(parsed.value)
    if ('error' in result) {
      return errorResponse(result.error, result.status)
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
    logger.error({ err: error }, 'Error creating number records')
    return errorResponse(errorMessage(error), 500)
  }
}
