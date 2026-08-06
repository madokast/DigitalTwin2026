import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import {
  fetchTransactionsSummary,
  parseTransactionsSummaryParams,
} from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const parsed = parseTransactionsSummaryParams(request.nextUrl.searchParams)
    if ('error' in parsed) {
      return errorResponse(parsed.error, 400)
    }

    const result = await fetchTransactionsSummary(
      parsed.from,
      parsed.to,
      parsed.fromRaw,
      parsed.toRaw,
    )

    return NextResponse.json(result)
  } catch (error) {
    return routeError(error, 'query transaction summary')
  }
}
