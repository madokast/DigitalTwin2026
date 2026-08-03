import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configError,
  formatRecordMessage,
  isTelegramConfigured,
  loadConfig,
  sendTelegramMessage,
  TELEGRAM_HTTP_TIMEOUT_MS,
  TELEGRAM_TRANSPORT_FAILED,
} from './telegram'

afterEach(() => {
  vi.restoreAllMocks()
})

const sampleNumber = {
  id: '01900000-0000-7000-8000-000000000001',
  happened_at: '2026-07-31T12:00:00.000Z',
  value_number: '72.5',
  value_text: null,
  tags: JSON.stringify(['weight', 'morning']),
  objective_context: 'Scale reading',
  subjective_interpretation: 'Feeling lighter',
}

const sampleText = {
  id: '01900000-0000-7000-8000-000000000002',
  happened_at: new Date('2026-07-31T13:00:00.000Z'),
  value_number: null,
  value_text: 'Ran 5k',
  tags: JSON.stringify(['run']),
  objective_context: 'Park loop',
  subjective_interpretation: null as string | null,
}

describe('loadConfig / isTelegramConfigured', () => {
  it('requires both token and user id non-empty', () => {
    expect(isTelegramConfigured({})).toBe(false)
    expect(isTelegramConfigured({ TELEGRAM_BOT_TOKEN: 't' })).toBe(false)
    expect(isTelegramConfigured({ TELEGRAM_USER_ID: '1' })).toBe(false)
    expect(
      isTelegramConfigured({
        TELEGRAM_BOT_TOKEN: '  ',
        TELEGRAM_USER_ID: '1',
      }),
    ).toBe(false)
    expect(
      isTelegramConfigured({
        TELEGRAM_BOT_TOKEN: 'tok',
        TELEGRAM_USER_ID: '42',
      }),
    ).toBe(true)
  })

  it('trims whitespace and lists missing keys', () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: '  tok  ',
        TELEGRAM_USER_ID: '  9  ',
      }),
    ).toEqual({
      configured: true,
      token: 'tok',
      userId: '9',
      missing: [],
    })
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: 'tok' }).missing).toEqual([
      'TELEGRAM_USER_ID',
    ])
  })
})

describe('configError', () => {
  it('names both when neither is set', () => {
    expect(configError({})).toBe(
      'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)',
    )
  })

  it('names the single missing env', () => {
    expect(configError({ TELEGRAM_BOT_TOKEN: 't' })).toBe(
      'Telegram is not configured (missing TELEGRAM_USER_ID)',
    )
    expect(configError({ TELEGRAM_USER_ID: '1' })).toBe(
      'Telegram is not configured (missing TELEGRAM_BOT_TOKEN)',
    )
  })

  it('returns null when configured', () => {
    expect(
      configError({
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_USER_ID: '1',
      }),
    ).toBeNull()
  })
})

describe('formatRecordMessage', () => {
  it('formats a number record in plain English text', () => {
    expect(formatRecordMessage(sampleNumber)).toBe(
      [
        'New record',
        'id: 01900000-0000-7000-8000-000000000001',
        'happened_at: 2026-07-31T12:00:00.000Z',
        'value_number: 72.5',
        'tags: weight, morning',
        'objective: Scale reading',
        'subjective: Feeling lighter',
      ].join('\n'),
    )
  })

  it('formats a text record and uses (null) for empty subjective', () => {
    expect(formatRecordMessage(sampleText)).toBe(
      [
        'New record',
        'id: 01900000-0000-7000-8000-000000000002',
        'happened_at: 2026-07-31T13:00:00.000Z',
        'value_text: Ran 5k',
        'tags: run',
        'objective: Park loop',
        'subjective: (null)',
      ].join('\n'),
    )
  })
})

describe('sendTelegramMessage', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'bot-tok', TELEGRAM_USER_ID: '99' }

  it('returns config error when not configured', async () => {
    const result = await sendTelegramMessage('hi', { env: {} })
    expect(result).toEqual({
      ok: false,
      error: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)',
    })
  })

  it('returns ok on Telegram ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    await expect(
      sendTelegramMessage('DigitalTwin2026 probe', { env, fetch: fetchMock }),
    ).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot-tok/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '99',
          text: 'DigitalTwin2026 probe',
          disable_web_page_preview: true,
        }),
      }),
    )
  })

  it('passes AbortSignal aligned with Go 15s HTTP client timeout', async () => {
    expect(TELEGRAM_HTTP_TIMEOUT_MS).toBe(15_000)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })
    await sendTelegramMessage('x', { env, fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('surfaces timeout as send failure without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted'))
    await expect(sendTelegramMessage('x', { env, fetch: fetchMock })).resolves.toEqual({
      ok: false,
      error: TELEGRAM_TRANSPORT_FAILED,
    })
  })

  it('surfaces Telegram description on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    })
    const result = await sendTelegramMessage('x', { env, fetch: fetchMock })
    expect(result).toEqual({
      ok: false,
      error: 'Telegram sendMessage failed: chat not found',
    })
  })
})
