import { describe, expect, it } from 'vitest'
import { formatHappenedAtUtc, toApiRecord } from '@/lib/record-json'

describe('formatHappenedAtUtc', () => {
  it('formats Date as UTC ISO with Z (matches Go FormatHappenedAt)', () => {
    expect(formatHappenedAtUtc(new Date('2026-07-30T08:00:00+08:00'))).toBe(
      '2026-07-30T00:00:00.000Z',
    )
  })

  it('normalizes offset strings to UTC Z', () => {
    expect(formatHappenedAtUtc('2026-07-30T08:00:00+08:00')).toBe(
      '2026-07-30T00:00:00.000Z',
    )
  })
})

describe('toApiRecord', () => {
  it('maps happenedAt to string and preserves other fields', () => {
    const rec = toApiRecord({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T10:00:00.000Z'),
      valueNumber: '75.5',
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'morning',
      subjectiveInterpretation: null,
    })
    expect(rec.happenedAt).toBe('2026-07-30T10:00:00.000Z')
    expect(typeof rec.happenedAt).toBe('string')
    expect(rec.valueNumber).toBe('75.5')
  })
})
