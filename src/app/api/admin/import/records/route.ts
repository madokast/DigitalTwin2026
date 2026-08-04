/**
 * POST /api/admin/import/records
 *
 * AdminToken（proxy）；multipart `file`；bypass readJsonBody / 256KiB 门闸。
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  extractMultipartBoundary,
  formatImportNotifyMessage,
  IMPORT_LIMITS_ERROR,
  importRecordsJsonl,
  isAcceptedImportFilePart,
  MAX_IMPORT_FILE_BYTES,
  MULTIPART_CONTENT_TYPE,
  MULTIPART_FILE_REQUIRED,
  MULTIPART_MULTIPLE_FILE,
  MULTIPART_PART_TOO_LARGE,
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
    // 与 Go mime.ParseMediaType 对齐：缺 boundary → 400，勿等 formData() 抛错落 500 catch
    if (!extractMultipartBoundary(contentType)) {
      return NextResponse.json(
        { error: MULTIPART_CONTENT_TYPE },
        { status: 400 },
      )
    }

    // 勿用 readJsonBody：multipart file 可达 4MiB，须 bypass 256KiB 门闸。
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      // boundary 存在但格式非法（如引号不闭合）：Go ParseMediaType 同样 400
      return NextResponse.json(
        { error: MULTIPART_CONTENT_TYPE },
        { status: 400 },
      )
    }

    // 与 Go 对齐（server.go 非 file part 丢弃也加 4MiB 上限）：先于 file 校验，
    // 与 Go 流式命中顺序一致。不可完全对齐点：Go 用 LimitReader 流式截断，Next 须先
    // 整体缓冲 formData 再检查——状态码 / 文案一致，内存占用特性不同（已注释）。
    for (const [name, value] of form.entries()) {
      if (name === 'file') continue
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value).length
          : value.size
      if (bytes > MAX_IMPORT_FILE_BYTES) {
        return NextResponse.json(
          { error: MULTIPART_PART_TOO_LARGE },
          { status: 400 },
        )
      }
    }
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
      // 与 Go 对齐（实测）：文本 part 名为 file → Go 视作 filename="" / CT="" →
      // IsAcceptedImportFilePart 拒绝 → unsupported file Content-Type（非 file-required）
      return NextResponse.json(
        { error: UNSUPPORTED_FILE_CONTENT_TYPE },
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
      atomic: true,
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
