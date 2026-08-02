import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Interface as ReadlineInterface } from 'node:readline'

vi.mock('./cli-prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli-prompt')>()
  return {
    ...actual,
    askLine: vi.fn(),
    askSecret: vi.fn(),
  }
})

vi.mock('./telegram-probe', () => ({
  telegramProbeSend: vi.fn(),
}))

vi.mock('./qqbot-probe', () => ({
  qqbotProbeSend: vi.fn(),
}))

import { askLine, askSecret } from './cli-prompt'
import { telegramProbeSend } from './telegram-probe'
import { qqbotProbeSend } from './qqbot-probe'
import { promptQqbotChannel, promptTelegramChannel } from './notify-prompt'

const rl = {} as ReadlineInterface

beforeEach(() => {
  vi.mocked(askLine).mockReset()
  vi.mocked(askSecret).mockReset()
  vi.mocked(telegramProbeSend).mockReset()
  vi.mocked(qqbotProbeSend).mockReset()
})

describe('promptTelegramChannel', () => {
  it('N → empty keys (bot off)', async () => {
    vi.mocked(askLine).mockResolvedValueOnce('')
    await expect(
      promptTelegramChannel(rl, { probeText: 'verify' }),
    ).resolves.toEqual({
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_USER_ID: '',
    })
    expect(askSecret).not.toHaveBeenCalled()
    expect(telegramProbeSend).not.toHaveBeenCalled()
  })

  it('Y without offerRepoEnv → manual stdin (no use-test question)', async () => {
    vi.mocked(askLine)
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
    vi.mocked(askSecret)
      .mockResolvedValueOnce('manual-tok')
      .mockResolvedValueOnce('42')
    vi.mocked(telegramProbeSend).mockResolvedValueOnce(null)

    await expect(
      promptTelegramChannel(rl, { probeText: 'verify' }),
    ).resolves.toEqual({
      TELEGRAM_BOT_TOKEN: 'manual-tok',
      TELEGRAM_USER_ID: '42',
    })

    const prompts = vi.mocked(askLine).mock.calls.map((c) => String(c[1]))
    expect(prompts.some((p) => p.includes('Use TELEGRAM_*'))).toBe(false)
    expect(telegramProbeSend).toHaveBeenCalledWith(
      'manual-tok',
      '42',
      'verify',
    )
  })

  it('Y + offerRepoEnv + default Yes → reuse test values', async () => {
    vi.mocked(askLine)
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('')
    vi.mocked(telegramProbeSend).mockResolvedValueOnce(null)

    await expect(
      promptTelegramChannel(rl, {
        probeText: 'verify',
        offerRepoEnv: { token: 'test-tok', userId: '7' },
      }),
    ).resolves.toEqual({
      TELEGRAM_BOT_TOKEN: 'test-tok',
      TELEGRAM_USER_ID: '7',
    })

    expect(askSecret).not.toHaveBeenCalled()
    const prompts = vi.mocked(askLine).mock.calls.map((c) => String(c[1]))
    expect(prompts.some((p) => p.includes('Use TELEGRAM_*'))).toBe(true)
  })

  it('Y + offerRepoEnv + No → manual stdin', async () => {
    vi.mocked(askLine)
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
    vi.mocked(askSecret)
      .mockResolvedValueOnce('other-tok')
      .mockResolvedValueOnce('99')
    vi.mocked(telegramProbeSend).mockResolvedValueOnce(null)

    await expect(
      promptTelegramChannel(rl, {
        probeText: 'verify',
        offerRepoEnv: { token: 'test-tok', userId: '7' },
      }),
    ).resolves.toEqual({
      TELEGRAM_BOT_TOKEN: 'other-tok',
      TELEGRAM_USER_ID: '99',
    })
  })
})

describe('promptQqbotChannel', () => {
  it('N → empty keys (bot off)', async () => {
    vi.mocked(askLine).mockResolvedValueOnce('n')
    await expect(
      promptQqbotChannel(rl, { probeText: 'verify' }),
    ).resolves.toEqual({
      QQBOT_APP_ID: '',
      QQBOT_APP_SECRET: '',
      QQBOT_USER_OPENID: '',
    })
    expect(askSecret).not.toHaveBeenCalled()
  })

  it('Y + offerRepoEnv + Yes → reuse QQBOT_* from test', async () => {
    vi.mocked(askLine)
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
    vi.mocked(qqbotProbeSend).mockResolvedValueOnce(null)

    await expect(
      promptQqbotChannel(rl, {
        probeText: 'verify',
        offerRepoEnv: {
          appId: 'app',
          appSecret: 'sec',
          userOpenid: 'oid',
        },
      }),
    ).resolves.toEqual({
      QQBOT_APP_ID: 'app',
      QQBOT_APP_SECRET: 'sec',
      QQBOT_USER_OPENID: 'oid',
    })
    expect(askSecret).not.toHaveBeenCalled()
  })

  it('Y without offerRepoEnv → no use-test question', async () => {
    vi.mocked(askLine)
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
      .mockResolvedValueOnce('y')
    vi.mocked(askSecret)
      .mockResolvedValueOnce('a')
      .mockResolvedValueOnce('b')
      .mockResolvedValueOnce('c')
    vi.mocked(qqbotProbeSend).mockResolvedValueOnce(null)

    await promptQqbotChannel(rl, { probeText: 'verify' })
    const prompts = vi.mocked(askLine).mock.calls.map((c) => String(c[1]))
    expect(prompts.some((p) => p.includes('Use QQBOT_*'))).toBe(false)
  })
})
