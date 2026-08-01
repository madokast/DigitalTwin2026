import { NextRequest, NextResponse } from 'next/server'
import {
  MAX_HTTP_BODY_BYTES,
  REQUEST_BODY_TOO_LARGE,
} from '@/lib/httpjson'
import {
  configError,
  sendTelegramMessage,
} from '@/lib/telegram'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

const PROBE_KEYS = ['text'] as const

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
      const body: unknown = JSON.parse(
        new TextDecoder('utf-8').decode(buf),
      )
      const unknown = rejectUnknownKeys(body, PROBE_KEYS)
      if (unknown) {
        return NextResponse.json({ error: unknown.error }, { status: 400 })
      }
      const textRaw = (body as { text?: unknown }).text
      if (typeof textRaw === 'string' && textRaw.trim() !== '') {
        text = textRaw.trim()
      }
    }
  } catch {
    // 空 body / 非 JSON：使用默认文案
  }

  const result = await sendTelegramMessage(text)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 })
  }
  return NextResponse.json({ success: true })
}
