import { NextRequest, NextResponse } from 'next/server'
import {
  fetchTransactionSummary,
  parseTransactionSummaryParams,
} from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const parsed = parseTransactionSummaryParams(request.nextUrl.searchParams)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const result = await fetchTransactionSummary(
      parsed.from,
      parsed.to,
      parsed.fromRaw,
      parsed.toRaw,
    )

    return NextResponse.json(result)
  } catch (error) {
    console.error('Error querying transaction summary:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
