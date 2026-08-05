import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  emptyStringToNull,
  parseHappenedAt,
  parseNumericValue,
  validateDecimalString,
  NUMERIC_VALUE_MUST_BE_STRING,
} from './draft'

const decimalCases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/decimal-string-cases.json',
    ),
    'utf8',
  ),
) as { accept: string[]; reject: string[] }

describe('emptyStringToNull', () => {
  it('maps empty string to null', () => {
    expect(emptyStringToNull('')).toBeNull()
  })

  it('maps null/undefined to null', () => {
    expect(emptyStringToNull(null)).toBeNull()
    expect(emptyStringToNull(undefined)).toBeNull()
  })

  it('keeps non-empty strings', () => {
    expect(emptyStringToNull('-')).toBe('-')
    expect(emptyStringToNull('hello')).toBe('hello')
  })
})

describe('parseHappenedAt', () => {
  it('accepts Z and ±HH:MM / ±HHMM offsets', () => {
    const z = parseHappenedAt('2026-07-30T00:00:00.000Z')
    expect(z).toEqual({
      ok: true,
      value: expect.any(Date),
      utcOffset: 'Z',
    })
    const offset = parseHappenedAt('2026-07-30T08:00:00+08:00')
    expect(offset).toEqual({
      ok: true,
      value: expect.any(Date),
      utcOffset: '+08:00',
    })
    const compact = parseHappenedAt('2026-07-30T08:00:00+0800')
    expect(compact).toEqual({
      ok: true,
      value: expect.any(Date),
      utcOffset: '+08:00',
    })
    if (!('error' in offset) && !('error' in compact)) {
      expect(compact.value.getTime()).toBe(offset.value.getTime())
    }
  })

  it('rejects bare date and missing offset', () => {
    expect(parseHappenedAt('2026-07-30')).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
    expect(parseHappenedAt('2026-07-30T08:00:00')).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
  })

  it('rejects forms Date accepts but Go RFC3339 rejects', () => {
    // 与 Go time.Parse(RFC3339*) / OpenAPI HappenedAtInput 对齐
    for (const raw of [
      '2026-07-30T08:00:00z', // 小写 z
      '2026-07-30 08:00:00Z', // 空格分隔
      '2026-7-30T08:00:00Z', // 月未补零
      '2026-07-30T8:00:00Z', // 时未补零
    ]) {
      expect(parseHappenedAt(raw), raw).toEqual({
        error: 'invalid happened_at datetime',
      })
    }
  })
})

describe('validateDecimalString / parseNumericValue', () => {
  it('accepts shared decimal-string fixtures', () => {
    for (const s of decimalCases.accept) {
      expect(validateDecimalString(s), s).toEqual({ ok: true })
      expect(parseNumericValue(s), s).toEqual({ ok: true, value: s })
    }
  })

  it('rejects shared decimal-string fixtures', () => {
    for (const bad of decimalCases.reject) {
      expect(validateDecimalString(bad), bad).toEqual({
        error: 'invalid numeric_value',
      })
      expect(parseNumericValue(bad), bad).toEqual({
        error: 'invalid numeric_value',
      })
    }
  })

  it('trims and maps blank / null; preserves trailing zeros', () => {
    expect(parseNumericValue('  1.0  ')).toEqual({ ok: true, value: '1.0' })
    expect(parseNumericValue('')).toEqual({ ok: true, value: null })
    expect(parseNumericValue(null)).toEqual({ ok: true, value: null })
  })

  it('rejects JSON number type', () => {
    expect(parseNumericValue(75.5)).toEqual({
      error: NUMERIC_VALUE_MUST_BE_STRING,
    })
    expect(parseNumericValue(1)).toEqual({
      error: NUMERIC_VALUE_MUST_BE_STRING,
    })
  })
})
