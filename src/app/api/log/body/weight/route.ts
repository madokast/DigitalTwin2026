import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { createBodyWeight } from '@/lib/logapi'
import { parseBodyWeight } from '@/lib/bodyweightdraft'
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

    const bw = parseBodyWeight(parsed.value)
    if ('error' in bw) {
      return errorResponse(bw.error, 400)
    }

    const result = await createBodyWeight(bw)
    
    scheduleBestEffortNotify(() => notifyRecordInserted(result))

    return NextResponse.json(
      { success: true, record: result },
      { status: 201 },
    )
  } catch (error) {
    return routeError(error, 'Error creating body weight record')
  }
}
