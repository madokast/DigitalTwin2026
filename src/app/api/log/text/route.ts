import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { logService, parseTextBody } from '@/lib/logapi'
import {
  notifyRecordInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const body = parseTextBody(parsed.value)
    if ('error' in body) {
      return errorResponse(body.error, 400)
    }

    const result = await logService.createText(body)
    
    // 响应写出后再通知，避免渠道阻塞 201；失败不影响已成功写入
    scheduleBestEffortNotify(() => notifyRecordInserted(result))

    return NextResponse.json(
      { success: true, record: result },
      { status: 201 },
    )
  } catch (error) {
    return routeError(error, 'Error creating text record')
  }
}
