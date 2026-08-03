import { NextRequest, NextResponse } from 'next/server'
import {
  buildExportNdjson,
  exportContentDisposition,
  fetchExportRecords,
  formatExportNotifyMessage,
  parseExportRecordsParams,
} from '@/lib/exportapi'
import { notify_user, scheduleBestEffortNotify } from '@/lib/notify'

export async function GET(request: NextRequest) {
  try {
    const parsed = parseExportRecordsParams(request.nextUrl.searchParams)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const result = await fetchExportRecords(parsed)
    if ('error' in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      )
    }

    // 校验/查库已完成；有界组 NDJSON（≤1000 行）后构造响应。
    // Notify 仅在成功响应构造之后调度（对齐 §4.5：写出失败不 Notify）。
    const body = buildExportNdjson(result.records)
    const now = new Date()
    const disposition = exportContentDisposition(parsed.from, parsed.limit, now)
    const notifyText = formatExportNotifyMessage(
      result.records.length,
      parsed.from,
      parsed.limit,
    )

    const response = new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': disposition,
      },
    })
    scheduleBestEffortNotify(() => notify_user(notifyText))
    return response
  } catch (error) {
    console.error('Error exporting records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
