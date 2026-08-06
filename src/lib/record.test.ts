import { describe, expect, it } from 'vitest'
import {
  formatHappenedAt,
  fromDB,
  isValidRecordId,
  tagsJSON,
} from '@/lib/record'

describe('isValidRecordId', () => {
  it('accepts UUIDv7 / nil UUID like npm uuid.validate', () => {
    expect(isValidRecordId('01900000-0000-7000-8000-000000000001')).toBe(true)
    expect(isValidRecordId('00000000-0000-0000-0000-000000000000')).toBe(true)
  })

  it('rejects illegal version/variant that google/uuid.Parse would accept', () => {
    expect(isValidRecordId('a0eebc99-9c0b-4ef8-7000-6bb9bd380a11')).toBe(false)
    expect(isValidRecordId('01234567-89ab-cdef-0123-456789abcdef')).toBe(false)
  })
})

describe('formatHappenedAt (UTC Z fallback only)', () => {
  it('formats Date as UTC ISO with Z (corrupt-offset fallback)', () => {
    expect(formatHappenedAt(new Date('2026-07-30T08:00:00+08:00'))).toBe(
      '2026-07-30T00:00:00.000Z',
    )
  })

  it('normalizes offset strings to UTC Z', () => {
    expect(formatHappenedAt('2026-07-30T08:00:00+08:00')).toBe(
      '2026-07-30T00:00:00.000Z',
    )
  })
})

describe('fromDB', () => {
  it('maps DB row to snake_case API Record with utc_offset formatting', () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T10:00:00.000Z'),
      utcOffset: 'Z',
      numericValue: '75.5',
      rawContent: null,
      tags: ['weight'],
      objectiveContext: 'morning',
      aiAnalysis: null,
    })
    expect(rec.happened_at).toBe('2026-07-30T10:00:00.000Z')
    expect(typeof rec.happened_at).toBe('string')
    expect(rec.numeric_value).toBe('75.5')
  })

  it('formats happened_at with stored +08:00 offset', () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000002',
      happenedAt: new Date('2026-07-30T00:00:00.000Z'),
      utcOffset: '+08:00',
      numericValue: '1',
      rawContent: null,
      tags: ['weight'],
      objectiveContext: 'x',
      aiAnalysis: null,
    })
    expect(rec.happened_at).toBe('2026-07-30T08:00:00.000+08:00')
  })
})

describe('tagsJSON', () => {
  it('marshals tags array to JSON string', () => {
    expect(tagsJSON(['weight', 'morning'])).toBe('["weight","morning"]')
  })
})
