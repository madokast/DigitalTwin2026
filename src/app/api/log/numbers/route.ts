import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
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
    return routeError(error, 'Error creating number records')
  }
}
