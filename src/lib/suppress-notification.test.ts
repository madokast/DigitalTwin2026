import { describe, expect, it } from 'vitest'
import { readSuppressNotification } from './suppress-notification'

describe('readSuppressNotification', () => {
  it('omitted key → false', () => {
    expect(readSuppressNotification({ value_number: '1' })).toEqual({
      ok: true,
      value: false,
    })
  })

  it('null → false', () => {
    expect(
      readSuppressNotification({ suppress_notification: null }),
    ).toEqual({ ok: true, value: false })
  })

  it('undefined value → false', () => {
    expect(
      readSuppressNotification({ suppress_notification: undefined }),
    ).toEqual({ ok: true, value: false })
  })

  it('false → false', () => {
    expect(
      readSuppressNotification({ suppress_notification: false }),
    ).toEqual({ ok: true, value: false })
  })

  it('true → true', () => {
    expect(
      readSuppressNotification({ suppress_notification: true }),
    ).toEqual({ ok: true, value: true })
  })

  it('string "true" → 400', () => {
    expect(
      readSuppressNotification({ suppress_notification: 'true' }),
    ).toEqual({ ok: false, error: 'Invalid suppress_notification' })
  })

  it('number → 400', () => {
    expect(
      readSuppressNotification({ suppress_notification: 1 }),
    ).toEqual({ ok: false, error: 'Invalid suppress_notification' })
  })

  it('non-object body → false (omit)', () => {
    expect(readSuppressNotification(null)).toEqual({ ok: true, value: false })
    expect(readSuppressNotification([])).toEqual({ ok: true, value: false })
    expect(readSuppressNotification('x')).toEqual({ ok: true, value: false })
  })
})
