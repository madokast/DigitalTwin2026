import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/httperror'
import { createBodyWeight } from '@/lib/logapi'
import type { LogBodyWeightBody } from '@/lib/bodyweightdraft'
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

    const result = await createBodyWeight(parsed.value as LogBodyWeightBody)
    if ('error' in result) {
      return errorResponse(result.error, result.status)
    }

    scheduleBestEffortNotify(() => notifyRecordInserted(result.record))

    return NextResponse.json(
      { success: true, record: result.record },
      { status: result.status },
    )
  } catch (error) {
    logger.error({ err: error }, 'Error creating body weight record')
    return errorResponse('Internal server error', 500)
  }
}
