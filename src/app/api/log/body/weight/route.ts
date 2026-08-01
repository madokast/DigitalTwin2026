import { NextRequest, NextResponse } from 'next/server'
import { createBodyWeight } from '@/lib/logapi'
import type { LogBodyWeightBody } from '@/lib/bodyweightdraft'
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

    const result = await createBodyWeight(parsed.value as LogBodyWeightBody)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    if (!suppress.value) {
      scheduleBestEffortNotify(() => notifyRecordInserted(result.record))
    }

    return NextResponse.json(
      { success: true, record: result.record },
      { status: result.status },
    )
  } catch (error) {
    console.error('Error creating body weight record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
