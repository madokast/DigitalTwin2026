import { NextRequest, NextResponse } from 'next/server'
import {
  MAX_HTTP_BODY_BYTES,
  REQUEST_BODY_TOO_LARGE,
} from '@/lib/httpjson'
import { configError, sendQqMessage } from '@/lib/qqbot'

interface ProbeBody {
  text?: string
}

export async function POST(request: NextRequest) {
  const err = configError()
  if (err) {
    return NextResponse.json({ error: err }, { status: 400 })
  }

  let text = 'DigitalTwin2026 probe'
  try {
    const buf = await request.arrayBuffer()
    if (buf.byteLength > MAX_HTTP_BODY_BYTES) {
      return NextResponse.json(
        { error: REQUEST_BODY_TOO_LARGE },
        { status: 413 },
      )
    }
    if (buf.byteLength > 0) {
      const body = JSON.parse(new TextDecoder('utf-8').decode(buf)) as ProbeBody
      if (typeof body?.text === 'string' && body.text.trim() !== '') {
        text = body.text.trim()
      }
    }
  } catch {
    // 空 body / 非 JSON：使用默认文案
  }

  const result = await sendQqMessage(text)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}
