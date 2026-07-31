import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

function probeRequest(body?: unknown): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/api/telegram/probe', {
      method: 'POST',
    })
  }
  return new NextRequest('http://localhost/api/telegram/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/telegram/probe', () => {
  it('returns 400 when Telegram env is missing', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '')
    vi.stubEnv('TELEGRAM_USER_ID', '')
    const { POST } = await import('./route')
    const res = await POST(probeRequest())
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)',
    })
  })

  it('returns 400 naming the single missing env', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok')
    vi.stubEnv('TELEGRAM_USER_ID', '')
    const { POST } = await import('./route')
    const res = await POST(probeRequest())
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'Telegram is not configured (missing TELEGRAM_USER_ID)',
    })
  })

  it('returns 502 with Telegram reason on send failure', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok')
    vi.stubEnv('TELEGRAM_USER_ID', '1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: 'chat not found' }),
      }),
    )
    const { POST } = await import('./route')
    const res = await POST(probeRequest())
    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toEqual({
      error: 'Telegram sendMessage failed: chat not found',
    })
  })

  it('returns 200 on success and accepts optional text', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok')
    vi.stubEnv('TELEGRAM_USER_ID', '1')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { POST } = await import('./route')
    const res = await POST(probeRequest({ text: 'custom probe' }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        body: expect.stringContaining('custom probe'),
      }),
    )
  })
})
