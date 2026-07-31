import { describe, expect, it } from 'vitest'
import {
  emptyStringToNull,
  parseHappenedAt,
  parseRecordDraft,
  parseValueNumber,
  validateDecimalString,
  VALUE_NUMBER_MUST_BE_STRING,
} from './record-draft'

const validBase = {
  happened_at: '2026-07-30T08:00:00+08:00',
  value_number: '75.5',
  value_text: null,
  tags: ['weight'],
  objective_context: 'morning weigh-in',
  subjective_interpretation: null,
}

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
  it('accepts Z and ±HH:MM offsets', () => {
    const z = parseHappenedAt('2026-07-30T00:00:00.000Z')
    expect('error' in z).toBe(false)
    const offset = parseHappenedAt('2026-07-30T08:00:00+08:00')
    expect('error' in offset).toBe(false)
  })

  it('rejects bare date and missing offset', () => {
    expect(parseHappenedAt('2026-07-30')).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
    expect(parseHappenedAt('2026-07-30T08:00:00')).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
  })
})

describe('validateDecimalString / parseValueNumber', () => {
  it('accepts valid literals and preserves trailing zeros', () => {
    expect(validateDecimalString('1')).toEqual({ ok: true })
    expect(validateDecimalString('75.5')).toEqual({ ok: true })
    expect(validateDecimalString('1.0')).toEqual({ ok: true })
    expect(parseValueNumber('  1.0  ')).toEqual({ ok: true, value: '1.0' })
    expect(parseValueNumber('')).toEqual({ ok: true, value: null })
    expect(parseValueNumber(null)).toEqual({ ok: true, value: null })
  })

  it('rejects JSON number type', () => {
    expect(parseValueNumber(75.5)).toEqual({
      error: VALUE_NUMBER_MUST_BE_STRING,
    })
    expect(parseValueNumber(1)).toEqual({
      error: VALUE_NUMBER_MUST_BE_STRING,
    })
  })

  it('rejects scientific notation, +sign, incomplete decimals, leading zeros', () => {
    for (const bad of ['1e3', '1E3', '+1', '1.', '.5', '01', '00.5', '1,000']) {
      expect(parseValueNumber(bad)).toEqual({ error: 'Invalid value_number' })
    }
  })
})

describe('parseRecordDraft', () => {
  it('accepts a valid number record snapshot', () => {
    const parsed = parseRecordDraft(validBase)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.valueNumber).toBe('75.5')
    expect(parsed.valueText).toBeNull()
    expect(parsed.tags).toEqual(['weight'])
    expect(parsed.objectiveContext).toBe('morning weigh-in')
    expect(parsed.subjectiveInterpretation).toBeNull()
  })

  it('rejects happened_at without timezone', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      happened_at: '2026-07-30T08:00:00',
    })
    expect(parsed).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
  })

  it('rejects when both values are null/empty', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        value_number: null,
        value_text: '',
      }),
    ).toEqual({
      error: 'value_number and value_text cannot both be null',
    })
  })

  it('maps empty value_text and subjective to null', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      value_number: '1',
      value_text: '',
      subjective_interpretation: '',
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.valueText).toBeNull()
    expect(parsed.subjectiveInterpretation).toBeNull()
  })

  it('rejects JSON number value_number', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        value_number: 75.5,
      }),
    ).toEqual({ error: VALUE_NUMBER_MUST_BE_STRING })
  })

  it('rejects empty objective_context', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        objective_context: '',
      }),
    ).toEqual({
      error: 'Missing required field: objective_context',
    })
  })

  it('rejects invalid tags', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      tags: ['体重'],
    })
    expect('error' in parsed).toBe(true)
    if (!('error' in parsed)) return
    expect(parsed.error).toContain('Invalid tag')
  })

  it('rejects empty tags array', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        tags: [],
      }),
    ).toEqual({
      error: 'Missing required field: tags (non-empty array)',
    })
  })

  it('accepts empty value_number with text-only records', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      value_number: '',
      value_text: 'hello',
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.valueNumber).toBeNull()
    expect(parsed.valueText).toBe('hello')
  })
})
