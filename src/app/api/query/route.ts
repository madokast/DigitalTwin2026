import { logger } from '@/lib/logger'
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/httperror'
import {
  fetchFilteredRecords,
  parseRecordQueryParams,
  toQueryRecordJson,
} from '@/lib/query'

export async function GET(request: NextRequest) {
  try {
    const parsed = parseRecordQueryParams(request.nextUrl.searchParams)
    if ('error' in parsed) {
      return errorResponse(parsed.error, 400)
    }

    const result = await fetchFilteredRecords(parsed)

    const body: Record<string, unknown> = {
      success: true,
      count: result.total,
      page: result.page,
      page_size: result.pageSize,
      sort_by: parsed.sortBy,
      sort_order: parsed.sortOrder,
      records: result.records.map(toQueryRecordJson),
    }
    if (parsed.hint) {
      body.hint = parsed.hint
    }
    return NextResponse.json(body)
  } catch (error) {
    logger.error({ err: error }, 'query records')
    return errorResponse('Internal server error', 500)
  }
}
