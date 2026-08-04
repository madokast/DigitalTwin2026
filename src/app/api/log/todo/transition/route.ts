import { NextRequest, NextResponse } from 'next/server'
import { transitionTodo } from '@/lib/logapi'
import type { LogTodoTransitionBody } from '@/lib/tododraft'
import { readJsonBody } from '@/lib/httpjson'
import { notify_user, scheduleBestEffortNotify } from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    const result = await transitionTodo(parsed.value as LogTodoTransitionBody)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    // §4.2：恰好一次 notify，正文 = 审计 value_text（非待办行格式化）
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
    console.error('Error transitioning to-do:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
