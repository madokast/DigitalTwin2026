import { describe, expect, it } from 'vitest'
import {
  OPTIONAL_EMPTY,
  REQUIRED_KEYS,
  emptyInputPolicy,
} from './refresh-prod-env'

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

  it('offers telegram empty menu for TELEGRAM_*', () => {
    expect(OPTIONAL_EMPTY.has('TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(OPTIONAL_EMPTY.has('TELEGRAM_USER_ID')).toBe(true)
    expect(emptyInputPolicy('TELEGRAM_BOT_TOKEN')).toBe('telegram')
    expect(emptyInputPolicy('TELEGRAM_USER_ID')).toBe('telegram')
  })
})
