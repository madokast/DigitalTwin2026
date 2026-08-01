import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notify_user,
  notifyRecordInserted,
  scheduleBestEffortNotify,
  shouldSkipNotifyInTest,
} from './notify'
import { clearAccessTokenCacheForTests } from './qqbot'

afterEach(() => {
  clearAccessTokenCacheForTests()
  vi.restoreAllMocks()
})

describe('shouldSkipNotifyInTest', () => {
  it('skips when DIGITAL_TWIN_TEST=1 unless allow flag', () => {
    expect(shouldSkipNotifyInTest({ DIGITAL_TWIN_TEST: '1' })).toBe(true)
    expect(
      shouldSkipNotifyInTest({
        DIGITAL_TWIN_TEST: '1',
        NOTIFY_ALLOW_IN_TEST: '1',
      }),
    ).toBe(false)
  })

  it('falls back to process.env when injected flag is empty', () => {
    // tests/setup.ts 设 DIGITAL_TWIN_TEST=1；空注入应回退到 process.env
    expect(shouldSkipNotifyInTest({})).toBe(true)
    expect(shouldSkipNotifyInTest({ NOTIFY_ALLOW_IN_TEST: '1' })).toBe(false)
  })
})

const sampleNumber = {
  id: '01900000-0000-7000-8000-000000000001',
  happenedAt: '2026-07-31T12:00:00.000Z',
  valueNumber: '72.5',
  valueText: null,
  tags: JSON.stringify(['weight', 'morning']),
  objectiveContext: 'Scale reading',
  subjectiveInterpretation: 'Feeling lighter',
}

describe('scheduleBestEffortNotify', () => {
  it('runs task outside Next request scope (route unit tests / fallback)', async () => {
    const task = vi.fn().mockResolvedValue(undefined)
    scheduleBestEffortNotify(task)
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1))
  })
})

describe('notify_user', () => {
  it('skips in test mode even when channels are configured', async () => {
    const fetchMock = vi.fn()
    await notify_user('hello', {
      env: {
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_USER_ID: '1',
        QQBOT_APP_ID: 'a',
        QQBOT_APP_SECRET: 's',
        QQBOT_USER_OPENID: 'o',
        DIGITAL_TWIN_TEST: '1',
      },
      fetch: fetchMock,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('warns when no channels configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
    await notify_user('hello', {
      env: { NOTIFY_ALLOW_IN_TEST: '1' },
      fetch: fetchMock,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('Notify skipped: no channels configured')
  })

  it('sends Telegram only when only Telegram is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    await notify_user('hi', {
      env: {
        TELEGRAM_BOT_TOKEN: 'tok',
        TELEGRAM_USER_ID: '9',
        NOTIFY_ALLOW_IN_TEST: '1',
      },
      fetch: fetchMock,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('api.telegram.org')
  })

  it('sends QQ only when only QQ is configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'qt', expires_in: 7200 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      })
    await notify_user('hi', {
      env: {
        QQBOT_APP_ID: 'a',
        QQBOT_APP_SECRET: 's',
        QQBOT_USER_OPENID: 'o',
        NOTIFY_ALLOW_IN_TEST: '1',
      },
      fetch: fetchMock,
    })
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('bots.qq.com'))).toBe(
      true,
    )
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/v2/users/')),
    ).toBe(true)
  })

  it('sends Telegram and QQ in parallel when both configured', async () => {
    let inflight = 0
    let maxInflight = 0
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 30))
      inflight -= 1
      if (String(url).includes('bots.qq.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'qt', expires_in: 7200 }),
        }
      }
      if (String(url).includes('/v2/users/')) {
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({}),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }
    })

    await notify_user('hi', {
      env: {
        TELEGRAM_BOT_TOKEN: 'tok',
        TELEGRAM_USER_ID: '9',
        QQBOT_APP_ID: 'a',
        QQBOT_APP_SECRET: 's',
        QQBOT_USER_OPENID: 'o',
        NOTIFY_ALLOW_IN_TEST: '1',
      },
      fetch: fetchMock,
    })

    expect(maxInflight).toBeGreaterThanOrEqual(2)
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('api.telegram.org')),
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/v2/users/')),
    ).toBe(true)
  })

  it('returns after timeout without throwing when a channel hangs', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise(() => {}),
    )
    const started = Date.now()
    await expect(
      notify_user('hi', {
        env: {
          TELEGRAM_BOT_TOKEN: 'tok',
          TELEGRAM_USER_ID: '9',
          NOTIFY_ALLOW_IN_TEST: '1',
        },
        fetch: fetchMock,
        timeoutMs: 50,
      }),
    ).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('logs channel failure without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })
    await expect(
      notify_user('hi', {
        env: {
          TELEGRAM_BOT_TOKEN: 't',
          TELEGRAM_USER_ID: '1',
          NOTIFY_ALLOW_IN_TEST: '1',
        },
        fetch: fetchMock,
      }),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
  })
})

describe('notifyRecordInserted', () => {
  it('skips when unconfigured and does not call fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
    await notifyRecordInserted(sampleNumber, {
      env: { NOTIFY_ALLOW_IN_TEST: '1' },
      fetch: fetchMock,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('formats then notifies via notify_user', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    await notifyRecordInserted(sampleNumber, {
      env: {
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_USER_ID: '1',
        NOTIFY_ALLOW_IN_TEST: '1',
      },
      fetch: fetchMock,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('New record'),
      }),
    )
  })
})
