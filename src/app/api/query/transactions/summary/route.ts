import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import {
  fetchTransactionsSummary,
  parseTransactionsSummaryParams,
} from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const parsed = parseTransactionsSummaryParams(request.nextUrl.searchParams)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const result = await fetchTransactionsSummary(
      parsed.from,
      parsed.to,
      parsed.fromRaw,
      parsed.toRaw,
    )

    return NextResponse.json(result)
  } catch (error) {
    logger.error({ err: error }, 'query transaction summary')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
