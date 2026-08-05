import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/httperror'
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
    if ('error' in result) {
      return errorResponse(result.error, result.status)
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
    logger.error({ err: error }, 'Error creating transaction records')
    return errorResponse('Internal server error', 500)
  }
}
