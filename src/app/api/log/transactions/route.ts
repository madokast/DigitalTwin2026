import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { logService } from '@/lib/logapi'
import { parseTransactionBatch } from '@/lib/transactiondraft'
import {
  notifyTransactionBatchInserted,
  scheduleBestEffortNotify,
} from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const batch = parseTransactionBatch(parsed.value)
    if ('error' in batch) {
      return errorResponse(batch.error, 400)
    }

    const result = await logService.createTransactionBatch(batch)
    
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
