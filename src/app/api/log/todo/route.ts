import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { logService } from '@/lib/logapi'
import { parseTodo } from '@/lib/tododraft'
import { toTodoRecordJson } from '@/lib/tododraft'
import { readJsonBody } from '@/lib/httpjson'
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

    const todo = parseTodo(parsed.value)
    if ('error' in todo) {
      return errorResponse(todo.error, 400)
    }

    const result = await logService.createTodo(todo)
    
    scheduleBestEffortNotify(() => notifyRecordInserted(result))

    return NextResponse.json(
      { success: true, record: toTodoRecordJson(result) },
      { status: 201 },
    )
  } catch (error) {
    return routeError(error, 'Error creating to-do record')
  }
}
