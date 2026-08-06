import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { errorMessage, errorResponse } from '@/lib/httperror'
import { transitionTodo } from '@/lib/logapi'
import type { LogTodoTransitionBody } from '@/lib/tododraft'
import { readJsonBody } from '@/lib/httpjson'
import { notify_user, scheduleBestEffortNotify } from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const result = await transitionTodo(parsed.value as LogTodoTransitionBody)
    if ('error' in result) {
      return errorResponse(result.error, result.status)
    }

    // §4.2：恰好一次 notify，正文 = 审计 raw_content（非待办行格式化）
    scheduleBestEffortNotify(() => notify_user(result.todoAuditNotifyText))

    return NextResponse.json(
      {
        success: true,
        id: result.id,
        transition: { from: result.from, to: result.to },
      },
      { status: result.status },
    )
  } catch (error) {
    logger.error({ err: error }, 'Error transitioning to-do')
    return errorResponse(errorMessage(error), 500)
  }
}
