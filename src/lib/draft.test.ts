import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  emptyStringToNull,
  parseHappenedAt,
  parseRecordDraft,
  parseNumericValue,
  validateDecimalString,
  NUMERIC_VALUE_MUST_BE_STRING,
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
  numeric_value: '75.5',
  raw_content: null,
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
        error: 'Invalid happened_at datetime',
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
        error: 'Invalid numeric_value',
      })
      expect(parseNumericValue(bad), bad).toEqual({
        error: 'Invalid numeric_value',
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

describe('parseRecordDraft', () => {
  it('accepts a valid number record snapshot', () => {
    const parsed = parseRecordDraft(validBase)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.numericValue).toBe('75.5')
    expect(parsed.happenedAt).toBeInstanceOf(Date)
    expect(parsed.utcOffset).toBe('+08:00')
    expect(parsed.rawContent).toBeNull()
    expect(parsed.tags).toEqual(['weight'])
    expect(parsed.objectiveContext).toBe('morning weigh-in')
    expect(parsed.subjectiveInterpretation).toBeNull()
  })

  it('allows omitting happened_at (PATCH leaves time columns alone)', () => {
    const { happened_at: _omit, ...withoutTime } = validBase
    void _omit
    const parsed = parseRecordDraft(withoutTime)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.happenedAt).toBeNull()
    expect(parsed.utcOffset).toBeNull()
    expect(parsed.numericValue).toBe('75.5')
  })

  it('rejects utc_offset as unknown key', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        // @ts-expect-error intentional unknown key
        utc_offset: '+08:00',
      }),
    ).toEqual({ error: 'Unknown JSON key: utc_offset' })
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

  it('rejects when both values are null', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        numeric_value: null,
        raw_content: null,
      }),
    ).toEqual({
      error: 'numeric_value and raw_content cannot both be null',
    })
  })

  it('rejects empty / whitespace-only raw_content and subjective', () => {
    for (const raw_content of ['', '   ']) {
      const parsed = parseRecordDraft({
        ...validBase,
        numeric_value: '1',
        raw_content,
        subjective_interpretation: '   ',
      })
      expect('error' in parsed).toBe(true)
      if (!('error' in parsed)) return
      expect(parsed.error).toBe(
        raw_content === ''
          ? 'Missing required field: raw_content'
          : 'raw_content must not be blank',
      )
    }
  })

  it('maps omitted raw_content / subjective to null (clear via explicit null)', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      numeric_value: '1',
      raw_content: null,
      subjective_interpretation: null,
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.rawContent).toBeNull()
    expect(parsed.subjectiveInterpretation).toBeNull()
  })

  it('rejects JSON number numeric_value', () => {
    expect(
      parseRecordDraft({
        ...validBase,
        numeric_value: 75.5,
      }),
    ).toEqual({ error: NUMERIC_VALUE_MUST_BE_STRING })
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

  it('accepts empty tags array', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      tags: [],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.tags).toEqual([])
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

  it('accepts empty numeric_value with text-only records', () => {
    const parsed = parseRecordDraft({
      ...validBase,
      numeric_value: '',
      raw_content: 'hello',
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.numericValue).toBeNull()
    expect(parsed.rawContent).toBe('hello')
  })
})
