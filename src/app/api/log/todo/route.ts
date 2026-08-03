import { NextRequest, NextResponse } from 'next/server'
import { createTodo } from '@/lib/logapi'
import type { LogTodoBody } from '@/lib/tododraft'
import { toTodoRecordJson } from '@/lib/tododraft'
import { readJsonBody } from '@/lib/httpjson'
import {
  notifyRecordInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'
import { readSuppressNotification } from '@/lib/suppress-notification'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    // Create 前 peek：避免已写入却因字段类型 400
    const suppress = readSuppressNotification(parsed.value)
    if (!suppress.ok) {
      return NextResponse.json({ error: suppress.error }, { status: 400 })
    }

    const result = await createTodo(parsed.value as LogTodoBody)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    if (!suppress.value) {
      scheduleBestEffortNotify(() => notifyRecordInserted(result.record))
    }

    return NextResponse.json(
      { success: true, record: toTodoRecordJson(result.record) },
      { status: result.status },
    )
  } catch (error) {
    console.error('Error creating to-do record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
