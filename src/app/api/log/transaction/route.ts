import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/httpjson'
import { createTransactionBatch } from '@/lib/logapi'
import {
  notifyTransactionBatchInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'
import type { LogTransactionBody } from '@/lib/transactiondraft'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    const result = await createTransactionBatch(
      parsed.value as LogTransactionBody,
    )
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    scheduleBestEffortNotify(() =>
      notifyTransactionBatchInserted(result.records),
    )

    return NextResponse.json(
      {
        success: true,
        inserted: result.inserted,
        type: result.type,
        sum: result.sum,
        atomic: true,
      },
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
