import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as telegramProbe } from '@/app/api/telegram/probe/route'
import { POST as qqbotProbe } from '@/app/api/qqbot/probe/route'
import { clearAccessTokenCacheForTests } from '@/lib/qqbot'

/**
 * probe 契约（2026-08-04 与 Go 对齐）：
 * - 空 body → 发送默认文案 `DigitalTwin2026 probe`
 * - 非空但畸形 JSON / 尾部垃圾 → 400 `invalid JSON body`，不发送
 * - 数组 / null 等非对象 → 400 `request body must be a JSON object`
 * - 未知键 → 400 `Unknown JSON key: <key>`
 * 全程 mock fetch，绝不对真实 Telegram / QQ 投递。
 */

type FetchCall = { url: string; body: string | undefined }
let fetchCalls: FetchCall[] = []

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  }
}

function stubFetch() {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { body?: string }) => {
      fetchCalls.push({ url: input, body: init?.body })
      if (input.startsWith('https://bots.qq.com')) {
        return jsonResponse({ access_token: 'test-token', expires_in: 7200 })
      }
      return jsonResponse({ ok: true })
    }),
  )
}

/** fetch 调用中实际要发送的文案（telegram `text` / qqbot `content`） */
function sentTexts(): string[] {
  return fetchCalls
    .map((c) => {
      if (c.body == null) return null
      try {
        const parsed = JSON.parse(c.body) as {
          text?: string
          content?: string
        }
        return parsed.text ?? parsed.content ?? null
      } catch {
        return null
      }
    })
    .filter((s): s is string => s != null)
}

const endpoints = [
  {
    name: 'POST /api/telegram/probe',
    run: (req: NextRequest) => telegramProbe(req),
  },
  {
    name: 'POST /api/qqbot/probe',
    run: (req: NextRequest) => qqbotProbe(req),
  },
]

function rawPost(url: string, body: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token')
  vi.stubEnv('TELEGRAM_USER_ID', 'test-user')
  vi.stubEnv('QQBOT_APP_ID', 'test-app')
  vi.stubEnv('QQBOT_APP_SECRET', 'test-secret')
  vi.stubEnv('QQBOT_USER_OPENID', 'test-openid')
  clearAccessTokenCacheForTests()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

for (const ep of endpoints) {
  describe(ep.name, () => {
    it('empty body → 200, sends default text', async () => {
      const res = await ep.run(rawPost('http://localhost', ''))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true })
      expect(sentTexts()).toEqual(['DigitalTwin2026 probe'])
    })

    it('malformed JSON → 400 Invalid JSON body, nothing sent', async () => {
      const res = await ep.run(rawPost('http://localhost', '{broken'))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'invalid JSON body' })
      expect(fetchCalls).toHaveLength(0)
    })

    it('trailing garbage after valid JSON → 400, nothing sent', async () => {
      const res = await ep.run(rawPost('http://localhost', '{"text":"hi"} xyz'))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'invalid JSON body' })
      expect(fetchCalls).toHaveLength(0)
    })

    it('non-object JSON (array) → 400 Request body must be a JSON object', async () => {
      const res = await ep.run(rawPost('http://localhost', '[]'))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: 'request body must be a JSON object',
      })
      expect(fetchCalls).toHaveLength(0)
    })

    it('unknown key → 400 Unknown JSON key', async () => {
      const res = await ep.run(rawPost('http://localhost', '{"foo":"bar"}'))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: 'Unknown JSON key: foo',
      })
      expect(fetchCalls).toHaveLength(0)
    })

    it('valid text → 200, sends trimmed text', async () => {
      const res = await ep.run(rawPost('http://localhost', '{"text":"hi"}'))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true })
      expect(sentTexts()).toEqual(['hi'])
    })
  })
}
