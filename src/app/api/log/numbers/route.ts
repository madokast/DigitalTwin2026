import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { logService } from '@/lib/logapi'
import { parseNumberBatch } from '@/lib/numberdraft'
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

    const batch = parseNumberBatch(parsed.value)
    if ('error' in batch) {
      return errorResponse(batch.error, 400)
    }

    const result = await logService.createNumberBatch(batch)
    
    // 响应写出后再通知（整批一条摘要），避免渠道阻塞 201；失败不影响已成功写入
    scheduleBestEffortNotify(() => notifyNumberBatchInserted(result.records))

    return NextResponse.json(
      {
        success: true,
        inserted: result.inserted,
        atomic: true,
      },
      { status: 201 },
    )
  } catch (error) {
    return routeError(error, 'Error creating number records')
  }
}
