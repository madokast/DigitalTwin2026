import { NextRequest, NextResponse } from 'next/server'
import {
  configError,
  sendTelegramMessage,
} from '@/lib/telegram'

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
    const body = (await request.json()) as ProbeBody
    if (typeof body?.text === 'string' && body.text.trim() !== '') {
      text = body.text.trim()
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
