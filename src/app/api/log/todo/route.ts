import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { createTodo } from '@/lib/logapi'
import type { LogTodoBody } from '@/lib/tododraft'
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

    const result = await createTodo(parsed.value as LogTodoBody)
    
    scheduleBestEffortNotify(() => notifyRecordInserted(result))

    return NextResponse.json(
      { success: true, record: toTodoRecordJson(result) },
      { status: 201 },
    )
  } catch (error) {
    return routeError(error, 'Error creating to-do record')
  }
}
