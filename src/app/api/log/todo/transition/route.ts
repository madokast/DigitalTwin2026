import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { logService } from '@/lib/logapi'
import { parseTodoTransition } from '@/lib/tododraft'
import { readJsonBody } from '@/lib/httpjson'
import { notify_user, scheduleBestEffortNotify } from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const tt = parseTodoTransition(parsed.value)
    if ('error' in tt) {
      return errorResponse(tt.error, 400)
    }

    const result = await logService.transitionTodo(tt)
    
    // §4.2：恰好一次 notify，正文 = 审计 raw_content（非待办行格式化）
    scheduleBestEffortNotify(() => notify_user(result.todoAuditNotifyText))

    return NextResponse.json(
      {
        success: true,
        id: result.id,
        transition: { from: result.from, to: result.to },
      },
      { status: 200 },
    )
  } catch (error) {
    return routeError(error, 'Error transitioning to-do')
  }
}
