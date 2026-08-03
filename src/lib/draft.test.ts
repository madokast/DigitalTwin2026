import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  emptyStringToNull,
  parseHappenedAt,
  parseRecordDraft,
  parseValueNumber,
  validateDecimalString,
  VALUE_NUMBER_MUST_BE_STRING,
} from './draft'
import { reservedTagError } from './tags'

const decimalCases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/decimal-string-cases.json',
    ),
    'utf8',
  ),
) as { accept: string[]; reject: string[] }

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
  it('accepts Z and ±HH:MM / ±HHMM offsets', () => {
    const z = parseHappenedAt('2026-07-30T00:00:00.000Z')
    expect('error' in z).toBe(false)
    const offset = parseHappenedAt('2026-07-30T08:00:00+08:00')
    expect('error' in offset).toBe(false)
    const compact = parseHappenedAt('2026-07-30T08:00:00+0800')
    expect('error' in compact).toBe(false)
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
        error: 'Invalid happened_at datetime',
      })
    }
  })
})

describe('validateDecimalString / parseValueNumber', () => {
  it('accepts shared decimal-string fixtures', () => {
    for (const s of decimalCases.accept) {
      expect(validateDecimalString(s), s).toEqual({ ok: true })
      expect(parseValueNumber(s), s).toEqual({ ok: true, value: s })
    }
  })

  it('rejects shared decimal-string fixtures', () => {
    for (const bad of decimalCases.reject) {
      expect(validateDecimalString(bad), bad).toEqual({
        error: 'Invalid value_number',
      })
      expect(parseValueNumber(bad), bad).toEqual({
        error: 'Invalid value_number',
      })
    }
  })

  it('trims and maps blank / null; preserves trailing zeros', () => {
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

  it('rejects reserved tag transaction_entry', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        tags: ['transaction_entry'],
      }),
    ).toEqual({ error: reservedTagError('transaction_entry') })
  })

  it('rejects reserved prefix transaction_entry:income', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        tags: ['transaction_entry:income'],
      }),
    ).toEqual({ error: reservedTagError('transaction_entry:income') })
  })

  it('rejects reserved tag todo:in_progress', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        tags: ['todo:in_progress'],
      }),
    ).toEqual({ error: reservedTagError('todo:in_progress') })
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
