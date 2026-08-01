import { describe, expect, it } from 'vitest'
import { getZonedDayBounds, isValidTimeZone } from './timeutil'

describe('time helpers', () => {
  it('rejects invalid IANA time zones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })

  it('returns half-open [start, end) for the calendar day in the given zone', () => {
    // 2026-07-30 16:00 UTC = 2026-07-31 00:00 Asia/Shanghai
    const now = new Date('2026-07-30T16:30:00.000Z')

    const shanghai = getZonedDayBounds(now, 'Asia/Shanghai')
    expect(shanghai.start.toISOString()).toBe('2026-07-30T16:00:00.000Z')
    expect(shanghai.end.toISOString()).toBe('2026-07-31T16:00:00.000Z')

    const utc = getZonedDayBounds(now, 'UTC')
    expect(utc.start.toISOString()).toBe('2026-07-30T00:00:00.000Z')
    expect(utc.end.toISOString()).toBe('2026-07-31T00:00:00.000Z')
  })
})
