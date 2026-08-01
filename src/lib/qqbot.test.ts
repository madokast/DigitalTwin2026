import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAccessTokenCacheForTests,
  configError,
  isConfigured,
  loadConfig,
  QQBOT_HTTP_TIMEOUT_MS,
  QQBOT_TRANSPORT_FAILED,
  sendQqMessage,
} from './qqbot'

afterEach(() => {
  clearAccessTokenCacheForTests()
  vi.restoreAllMocks()
})

const configuredEnv = {
  QQBOT_APP_ID: 'app-1',
  QQBOT_APP_SECRET: 'sec-1',
  QQBOT_USER_OPENID: 'openid-1',
}

describe('loadConfig / isConfigured', () => {
  it('requires all three env keys non-empty', () => {
    expect(isConfigured({})).toBe(false)
    expect(isConfigured({ QQBOT_APP_ID: 'a' })).toBe(false)
    expect(
      isConfigured({
        QQBOT_APP_ID: 'a',
        QQBOT_APP_SECRET: 's',
      }),
    ).toBe(false)
    expect(
      isConfigured({
        QQBOT_APP_ID: '  ',
        QQBOT_APP_SECRET: 's',
        QQBOT_USER_OPENID: 'o',
      }),
    ).toBe(false)
    expect(isConfigured(configuredEnv)).toBe(true)
  })

  it('trims whitespace and lists missing keys', () => {
    expect(
      loadConfig({
        QQBOT_APP_ID: '  a  ',
        QQBOT_APP_SECRET: '  s  ',
        QQBOT_USER_OPENID: '  o  ',
      }),
    ).toEqual({
      configured: true,
      appId: 'a',
      appSecret: 's',
      userOpenid: 'o',
      missing: [],
    })
    expect(loadConfig({ QQBOT_APP_ID: 'a' }).missing).toEqual([
      'QQBOT_APP_SECRET',
      'QQBOT_USER_OPENID',
    ])
  })
})

describe('configError', () => {
  it('names all three when none are set', () => {
    expect(configError({})).toBe(
      'QQ Bot is not configured (QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID)',
    )
  })

  it('names the missing env keys', () => {
    expect(configError({ QQBOT_APP_ID: 'a' })).toBe(
      'QQ Bot is not configured (missing QQBOT_APP_SECRET, QQBOT_USER_OPENID)',
    )
    expect(
      configError({
        QQBOT_APP_ID: 'a',
        QQBOT_APP_SECRET: 's',
      }),
    ).toBe('QQ Bot is not configured (missing QQBOT_USER_OPENID)')
  })

  it('returns null when configured', () => {
    expect(configError(configuredEnv)).toBeNull()
  })
})

describe('sendQqMessage', () => {
  it('returns config error when not configured', async () => {
    const result = await sendQqMessage('hi', { env: {} })
    expect(result).toEqual({
      ok: false,
      error:
        'QQ Bot is not configured (QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID)',
    })
  })

  it('fetches token then sends proactive C2C without msg_id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-1', expires_in: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'm1' }),
        json: async () => ({ id: 'm1' }),
      })

    await expect(
      sendQqMessage('DigitalTwin2026 probe', {
        env: configuredEnv,
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://bots.qq.com/app/getAppAccessToken',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          appId: 'app-1',
          clientSecret: 'sec-1',
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.sgroup.qq.com/v2/users/openid-1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'QQBot tok-1',
        }),
        body: JSON.stringify({
          content: 'DigitalTwin2026 probe',
          msg_type: 0,
        }),
      }),
    )
    const sendBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as { body: string }).body,
    ) as Record<string, unknown>
    expect(sendBody).not.toHaveProperty('msg_id')
  })

  it('reuses cached access_token within refresh skew', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-cached', expires_in: 7200 }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      })

    await sendQqMessage('a', { env: configuredEnv, fetch: fetchMock })
    await sendQqMessage('b', { env: configuredEnv, fetch: fetchMock })

    const tokenCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === 'https://bots.qq.com/app/getAppAccessToken',
    )
    expect(tokenCalls).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('falls back to second API base on first send failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-1', expires_in: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ message: 'upstream' }),
        json: async () => ({ message: 'upstream' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      })

    await expect(
      sendQqMessage('hi', { env: configuredEnv, fetch: fetchMock }),
    ).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.bot.qq.com/v2/users/openid-1/messages',
      expect.any(Object),
    )
  })

  it('passes AbortSignal aligned with 15s timeout', async () => {
    expect(QQBOT_HTTP_TIMEOUT_MS).toBe(15_000)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 't', expires_in: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      })
    await sendQqMessage('x', { env: configuredEnv, fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('surfaces transport failure without throwing or leaking secrets', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('aborted'))
    const result = await sendQqMessage('x', {
      env: configuredEnv,
      fetch: fetchMock,
    })
    expect(result).toEqual({ ok: false, error: QQBOT_TRANSPORT_FAILED })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).not.toContain('sec-1')
  })

  it('surfaces QQ API message on both bases failing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-1', expires_in: 7200 }),
      })
      .mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'invalid openid' }),
        json: async () => ({ message: 'invalid openid' }),
      })
    const result = await sendQqMessage('x', {
      env: configuredEnv,
      fetch: fetchMock,
    })
    expect(result).toEqual({
      ok: false,
      error: 'QQ Bot sendMessage failed: invalid openid',
    })
  })
})
