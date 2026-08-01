import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/httpjson'
import { createTransactionBatch } from '@/lib/logapi'
import {
  notifyTransactionBatchInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'
import { readSuppressNotification } from '@/lib/suppress-notification'
import type { LogTransactionBody } from '@/lib/transactiondraft'

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

    const result = await createTransactionBatch(
      parsed.value as LogTransactionBody,
    )
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    if (!suppress.value) {
      scheduleBestEffortNotify(() =>
        notifyTransactionBatchInserted(result.records),
      )
    }

    return NextResponse.json(
      { success: true, inserted: result.inserted },
      { status: result.status },
    )
  } catch (error) {
    console.error('Error creating transaction records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
