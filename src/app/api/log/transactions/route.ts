import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { createTransactionBatch } from '@/lib/logapi'
import {
  notifyTransactionBatchInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'
import type { LogTransactionsBody } from '@/lib/transactiondraft'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const result = await createTransactionBatch(
      parsed.value as LogTransactionsBody,
    )
    
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
      { status: 201 },
    )
  } catch (error) {
    return routeError(error, 'Error creating transaction records')
  }
}
