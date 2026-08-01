import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  calendarDayBounds,
  expandCompactOffset,
  getZonedDayBounds,
  isValidTimeZone,
  parseRFC3339Flexible,
} from './timeutil'

type DayBoundCase = {
  name: string
  tz: string
  year: number
  month: number
  day: number
  startUtc: string
  endUtc: string
}

const dayBoundCases = (
  JSON.parse(
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../testdata/zoned-day-bounds-cases.json',
      ),
      'utf8',
    ),
  ) as { cases: DayBoundCase[] }
).cases

describe('time helpers', () => {
  it('rejects invalid IANA time zones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    // Go LoadLocation 会收下的非 IANA 名；Intl 与 API 均须拒绝
    expect(isValidTimeZone('Factory')).toBe(false)
    expect(isValidTimeZone('localtime')).toBe(false)
    expect(isValidTimeZone('posixrules')).toBe(false)
  })

  it('expandCompactOffset / parseRFC3339Flexible match Go', () => {
    expect(expandCompactOffset('2026-07-30T08:00:00+0800')).toBe(
      '2026-07-30T08:00:00+08:00',
    )
    expect(expandCompactOffset('2026-07-30T00:00:00.000Z')).toBe(
      '2026-07-30T00:00:00.000Z',
    )
    const ok = parseRFC3339Flexible('2026-07-30T08:00:00+0800')
    expect(ok?.toISOString()).toBe('2026-07-30T00:00:00.000Z')
    expect(parseRFC3339Flexible('2026-07-30T08:00:00z')).toBeNull()
    expect(parseRFC3339Flexible('2026-07-30 08:00:00Z')).toBeNull()
    expect(parseRFC3339Flexible('2026-7-30T08:00:00Z')).toBeNull()
    expect(parseRFC3339Flexible('2026-07-30T8:00:00Z')).toBeNull()
  })

  it('matches shared zoned-day-bounds fixtures (incl. DST)', () => {
    for (const c of dayBoundCases) {
      const { start, end } = calendarDayBounds(c.year, c.month, c.day, c.tz)
      expect(start.toISOString(), c.name).toBe(c.startUtc)
      expect(end.toISOString(), c.name).toBe(c.endUtc)
    }
  })

  it('getZonedDayBounds uses the calendar day of now in zone', () => {
    // 2026-07-30 16:30 UTC = 2026-07-31 00:30 Asia/Shanghai → 上海日历日 7/31
    const now = new Date('2026-07-30T16:30:00.000Z')
    const shanghai = getZonedDayBounds(now, 'Asia/Shanghai')
    expect(shanghai.start.toISOString()).toBe('2026-07-30T16:00:00.000Z')
    expect(shanghai.end.toISOString()).toBe('2026-07-31T16:00:00.000Z')
  })
})
