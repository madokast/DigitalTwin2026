import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

function probeRequest(body?: unknown): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/api/qqbot/probe', {
      method: 'POST',
    })
  }
  return new NextRequest('http://localhost/api/qqbot/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/qqbot/probe', () => {
  it('returns 400 when QQ Bot env is missing', async () => {
    vi.stubEnv('QQBOT_APP_ID', '')
    vi.stubEnv('QQBOT_APP_SECRET', '')
    vi.stubEnv('QQBOT_USER_OPENID', '')
    const { POST } = await import('./route')
    const res = await POST(probeRequest())
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error:
        'QQ Bot is not configured (QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID)',
    })
  })

  it('returns 400 naming the single missing env', async () => {
    vi.stubEnv('QQBOT_APP_ID', 'app')
    vi.stubEnv('QQBOT_APP_SECRET', 'sec')
    vi.stubEnv('QQBOT_USER_OPENID', '')
    const { POST } = await import('./route')
    const res = await POST(probeRequest())
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'QQ Bot is not configured (missing QQBOT_USER_OPENID)',
    })
  })

  it('returns 502 with QQ reason on send failure', async () => {
    vi.stubEnv('QQBOT_APP_ID', 'app')
    vi.stubEnv('QQBOT_APP_SECRET', 'sec')
    vi.stubEnv('QQBOT_USER_OPENID', 'openid')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok', expires_in: 7200 }),
        })
        .mockResolvedValue({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ message: 'invalid openid' }),
          json: async () => ({ message: 'invalid openid' }),
        }),
    )
    const { clearAccessTokenCacheForTests } = await import('@/lib/qqbot')
    clearAccessTokenCacheForTests()
    const { POST } = await import('./route')
    const res = await POST(probeRequest())
    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toEqual({
      error: 'QQ Bot sendMessage failed: invalid openid',
    })
  })

  it('returns 200 on success and accepts optional text', async () => {
    vi.stubEnv('QQBOT_APP_ID', 'app')
    vi.stubEnv('QQBOT_APP_SECRET', 'sec')
    vi.stubEnv('QQBOT_USER_OPENID', 'openid')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok', expires_in: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      })
    vi.stubGlobal('fetch', fetchMock)
    const { clearAccessTokenCacheForTests } = await import('@/lib/qqbot')
    clearAccessTokenCacheForTests()
    const { POST } = await import('./route')
    const res = await POST(probeRequest({ text: 'custom probe' }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v2/users/'),
      expect.objectContaining({
        body: expect.stringContaining('custom probe'),
      }),
    )
  })
})
