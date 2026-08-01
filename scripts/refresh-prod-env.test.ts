import { describe, expect, it } from 'vitest'
import {
  REQUIRED_KEYS,
  emptyInputPolicy,
} from './refresh-prod-env'
import {
  channelEnableDecision,
  shouldSkipNotifyPrompt,
} from './lib/notify-prompt'

describe('emptyInputPolicy', () => {
  it('rejects empty for the three required keys', () => {
    expect(REQUIRED_KEYS).toEqual([
      'DATABASE_URL',
      'DIGITAL_TWIN_TOKEN',
      'DIGITAL_TWIN_ADMIN_TOKEN',
    ])
    for (const key of REQUIRED_KEYS) {
      expect(emptyInputPolicy(key)).toBe('reject')
    }
  })

  it('skips empty for notify keys (handled by enable prompts)', () => {
    expect(emptyInputPolicy('TELEGRAM_BOT_TOKEN')).toBe('skip')
    expect(emptyInputPolicy('TELEGRAM_USER_ID')).toBe('skip')
    expect(emptyInputPolicy('QQBOT_APP_ID')).toBe('skip')
    expect(emptyInputPolicy('QQBOT_APP_SECRET')).toBe('skip')
    expect(emptyInputPolicy('QQBOT_USER_OPENID')).toBe('skip')
  })
})

describe('channelEnableDecision', () => {
  it('defaults to disable; y/yes enable', () => {
    expect(channelEnableDecision('')).toBe('disable')
    expect(channelEnableDecision('n')).toBe('disable')
    expect(channelEnableDecision('N')).toBe('disable')
    expect(channelEnableDecision('y')).toBe('enable')
    expect(channelEnableDecision('YES')).toBe('enable')
  })
})

describe('shouldSkipNotifyPrompt', () => {
  it('accepts DT_SKIP_NOTIFY_PROMPT or legacy DT_SKIP_TELEGRAM_PROMPT', () => {
    expect(shouldSkipNotifyPrompt({})).toBe(false)
    expect(shouldSkipNotifyPrompt({ DT_SKIP_NOTIFY_PROMPT: '1' })).toBe(true)
    expect(shouldSkipNotifyPrompt({ DT_SKIP_TELEGRAM_PROMPT: '1' })).toBe(true)
    expect(shouldSkipNotifyPrompt({ DT_SKIP_NOTIFY_PROMPT: '0' })).toBe(false)
  })
})
