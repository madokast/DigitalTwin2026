import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/httperror'
import {
  INVALID_JSON_BODY,
  MAX_HTTP_BODY_BYTES,
  REQUEST_BODY_TOO_LARGE,
} from '@/lib/httpjson'
import { configError, sendQqMessage } from '@/lib/qqbot'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

const PROBE_KEYS = ['text'] as const

export async function POST(request: NextRequest) {
  const err = configError()
  if (err) {
    return errorResponse(err, 400)
  }

  let text = 'DigitalTwin2026 probe'
  try {
    const buf = await request.arrayBuffer()
    if (buf.byteLength > MAX_HTTP_BODY_BYTES) {
      return errorResponse(REQUEST_BODY_TOO_LARGE, 413)
    }
    if (buf.byteLength > 0) {
      const body: unknown = JSON.parse(
        new TextDecoder('utf-8').decode(buf),
      )
      const unknown = rejectUnknownKeys(body, PROBE_KEYS)
      if (unknown) {
        return errorResponse(unknown.error, 400)
      }
      const textRaw = (body as { text?: unknown }).text
      if (typeof textRaw === 'string' && textRaw.trim() !== '') {
        text = textRaw.trim()
      }
    }
  } catch {
    // 空 body 在 byteLength 检查后直接跳过解析；至此失败 = 畸形 JSON / 读取错误 → 400
    return errorResponse(INVALID_JSON_BODY, 400)
  }

  const result = await sendQqMessage(text)
  if (!result.ok) {
    return errorResponse(result.error, 502)
  }
  return NextResponse.json({ success: true })
}
