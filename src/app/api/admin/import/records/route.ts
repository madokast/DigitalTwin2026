/**
 * POST /api/admin/import/records
 *
 * AdminToken（proxy）；multipart `file`；bypass readJsonBody / 256KiB 门闸。
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  formatImportNotifyMessage,
  IMPORT_LIMITS_ERROR,
  importRecordsJsonl,
  isAcceptedImportFilePart,
  MAX_IMPORT_FILE_BYTES,
  MULTIPART_CONTENT_TYPE,
  MULTIPART_FILE_REQUIRED,
  MULTIPART_MULTIPLE_FILE,
  UNSUPPORTED_FILE_CONTENT_TYPE,
} from '@/lib/importapi'
import { notify_user, scheduleBestEffortNotify } from '@/lib/notify'

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return NextResponse.json(
        { error: MULTIPART_CONTENT_TYPE },
        { status: 400 },
      )
    }

    // 勿用 readJsonBody：multipart file 可达 4MiB，须 bypass 256KiB 门闸。
    const form = await request.formData()
    const parts = form.getAll('file')
    if (parts.length === 0) {
      return NextResponse.json(
        { error: MULTIPART_FILE_REQUIRED },
        { status: 400 },
      )
    }
    if (parts.length > 1) {
      return NextResponse.json(
        { error: MULTIPART_MULTIPLE_FILE },
        { status: 400 },
      )
    }

    const part = parts[0]
    if (typeof part === 'string' || part == null) {
      return NextResponse.json(
        { error: MULTIPART_FILE_REQUIRED },
        { status: 400 },
      )
    }

    const file = part as File
    const filename = file.name || null
    const partType = file.type || null
    if (!isAcceptedImportFilePart(partType, filename)) {
      return NextResponse.json(
        { error: UNSUPPORTED_FILE_CONTENT_TYPE },
        { status: 400 },
      )
    }

    // 与 Go LimitReader(…, 4MiB+1) 对齐：先判 size，避免超限仍无界 file.text()。
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      return NextResponse.json(
        { error: IMPORT_LIMITS_ERROR },
        { status: 400 },
      )
    }

    const fileBytes = file.size
    const text = await file.text()

    const result = await importRecordsJsonl(text, fileBytes)
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      )
    }

    // commit 已成功：先构造成功 200 JSON，再 schedule Notify（对齐导出写出后 Notify）。
    const response = NextResponse.json({
      success: true,
      inserted: result.counts.inserted,
      updated: result.counts.updated,
      total: result.counts.total,
    })
    scheduleBestEffortNotify(() =>
      notify_user(formatImportNotifyMessage(result.counts)),
    )
    return response
  } catch (error) {
    console.error('Error importing records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
