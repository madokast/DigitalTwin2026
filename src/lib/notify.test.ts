import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NOTIFY_MESSAGE_MAX_LEN,
  NOTIFY_TRUNCATION_SUFFIX,
  notify_user,
  notifyRecordInserted,
  scheduleBestEffortNotify,
  shouldSuppressBotNotification,
  truncateNotifyMessage,
} from './notify'
import { clearAccessTokenCacheForTests } from './qqbot'

afterEach(() => {
  clearAccessTokenCacheForTests()
  vi.restoreAllMocks()
})

const truncateCases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/notify-truncate-cases.json',
    ),
    'utf8',
  ),
) as {
  max_len: number
  suffix: string
  cases: Array<{
    name: string
    length: number
    cjk: boolean
    truncated: boolean
  }>
}

describe('truncateNotifyMessage', () => {
  it('constants stay byte-identical to Go notify', () => {
    expect(NOTIFY_MESSAGE_MAX_LEN).toBe(truncateCases.max_len)
    expect(NOTIFY_TRUNCATION_SUFFIX).toBe(truncateCases.suffix)
  })

  it('passes shared fixtures', () => {
    for (const tc of truncateCases.cases) {
      const unit = tc.cjk ? '字' : 'a'
      const input = unit.repeat(tc.length)
      const out = truncateNotifyMessage(input)
      if (!tc.truncated) {
        expect(out, tc.name).toBe(input)
        continue
      }
      expect(out.length, tc.name).toBe(NOTIFY_MESSAGE_MAX_LEN)
      expect(out.endsWith(NOTIFY_TRUNCATION_SUFFIX), tc.name).toBe(true)
      expect(out.startsWith(unit.repeat(10)), tc.name).toBe(true)
    }
  })
})

describe('shouldSuppressBotNotification', () => {
  it('skips only when SUPPRESS_BOT_NOTIFICATION trim equals 1', () => {
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: '1' }),
    ).toBe(true)
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: ' 1 ' }),
    ).toBe(true)
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: '0' }),
    ).toBe(false)
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: 'true' }),
    ).toBe(false)
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: 'yes' }),
    ).toBe(false)
  })

  it('falls back to process.env when injected flag is empty', () => {
    // tests/setup.ts 设 SUPPRESS_BOT_NOTIFICATION=1；空注入应回退到 process.env
    expect(shouldSuppressBotNotification({})).toBe(true)
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: '' }),
    ).toBe(true)
    expect(
      shouldSuppressBotNotification({ SUPPRESS_BOT_NOTIFICATION: '0' }),
    ).toBe(false)
  })
})

const sampleNumber = {
  id: '01900000-0000-7000-8000-000000000001',
  happened_at: '2026-07-31T12:00:00.000Z',
  numeric_value: '72.5',
  raw_content: null,
  tags: ['weight', 'morning'],
  objective_context: 'Scale reading',
  ai_analysis: 'Feeling lighter',
}

describe('scheduleBestEffortNotify', () => {
  it('runs task outside Next request scope (route unit tests / fallback)', async () => {
    const task = vi.fn().mockResolvedValue(undefined)
    scheduleBestEffortNotify(task)
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1))
  })
})

describe('notify_user', () => {
  it('skips when SUPPRESS_BOT_NOTIFICATION=1 even when channels are configured', async () => {
    const fetchMock = vi.fn()
    await notify_user('hello', {
      env: {
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_USER_ID: '1',
        QQBOT_APP_ID: 'a',
        QQBOT_APP_SECRET: 's',
        QQBOT_USER_OPENID: 'o',
        SUPPRESS_BOT_NOTIFICATION: '1',
      },
      fetch: fetchMock,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('warns when no channels configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
    await notify_user('hello', {
      env: { SUPPRESS_BOT_NOTIFICATION: '0' },
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
        SUPPRESS_BOT_NOTIFICATION: '0',
      },
      fetch: fetchMock,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('api.telegram.org')
  })

  it('truncates overlong text before sending to any channel', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    const long = 'a'.repeat(5000)
    await notify_user(long, {
      env: {
        TELEGRAM_BOT_TOKEN: 'tok',
        TELEGRAM_USER_ID: '9',
        SUPPRESS_BOT_NOTIFICATION: '0',
      },
      fetch: fetchMock,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      text: string
    }
    expect(body.text.length).toBe(NOTIFY_MESSAGE_MAX_LEN)
    expect(body.text.endsWith(NOTIFY_TRUNCATION_SUFFIX)).toBe(true)
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
        SUPPRESS_BOT_NOTIFICATION: '0',
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
        SUPPRESS_BOT_NOTIFICATION: '0',
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
          SUPPRESS_BOT_NOTIFICATION: '0',
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
          SUPPRESS_BOT_NOTIFICATION: '0',
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
      env: { SUPPRESS_BOT_NOTIFICATION: '0' },
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
        SUPPRESS_BOT_NOTIFICATION: '0',
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
