import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  extractUtcOffsetLiteral,
  formatHappenedAt,
} from './utcoffset'

type ExtractCase = {
  name: string
  input: string
  utc_offset?: string
  error?: string
}

type FormatCase = {
  name: string
  instant_utc: string
  utc_offset: string
  want: string
}

const fixtures = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/utc-offset-cases.json',
    ),
    'utf8',
  ),
) as { extract: ExtractCase[]; format: FormatCase[] }

describe('extractUtcOffsetLiteral', () => {
  for (const c of fixtures.extract) {
    it(c.name, () => {
      const got = extractUtcOffsetLiteral(c.input)
      if (c.error !== undefined) {
        expect(got).toEqual({ error: c.error })
        return
      }
      expect(got).toEqual({ ok: true, value: c.utc_offset })
    })
  }

  it('does not fold Z and +00:00', () => {
    expect(extractUtcOffsetLiteral('2026-08-03T08:00:00Z')).toEqual({
      ok: true,
      value: 'Z',
    })
    expect(extractUtcOffsetLiteral('2026-08-03T08:00:00+00:00')).toEqual({
      ok: true,
      value: '+00:00',
    })
  })
})

describe('formatHappenedAt(instant, utc_offset)', () => {
  for (const c of fixtures.format) {
    it(c.name, () => {
      const instant = new Date(c.instant_utc)
      expect(formatHappenedAt(instant, c.utc_offset)).toBe(c.want)
    })
  }

  it('same instant keeps distinct Z vs +00:00 suffixes', () => {
    const instant = new Date('2026-08-03T00:00:00.000Z')
    expect(formatHappenedAt(instant, 'Z')).toBe('2026-08-03T00:00:00.000Z')
    expect(formatHappenedAt(instant, '+00:00')).toBe(
      '2026-08-03T00:00:00.000+00:00',
    )
  })

  it('round-trip: extract then format preserves canonical offset', () => {
    const samples = [
      '2026-08-03T08:00:00Z',
      '2026-08-03T08:00:00+00:00',
      '2026-08-03T08:00:00+0800',
      '2026-08-03T08:00:00-0430',
    ]
    for (const raw of samples) {
      const extracted = extractUtcOffsetLiteral(raw)
      expect('ok' in extracted && extracted.ok).toBe(true)
      if (!('ok' in extracted) || !extracted.ok) return
      const instant = new Date(
        raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/z$/i, 'Z'),
      )
      const formatted = formatHappenedAt(instant, extracted.value)
      expect(formatted.endsWith(extracted.value)).toBe(true)
      expect(new Date(formatted).getTime()).toBe(instant.getTime())
    }
  })
})
