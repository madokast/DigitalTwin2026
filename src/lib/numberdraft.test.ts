import { describe, expect, it } from 'vitest'
import {
  MAX_NUMBER_ENTRIES,
  parseNumberBatch,
} from './numberdraft'

describe('parseNumberBatch', () => {
  const base = {
    happened_at: '2026-08-05T10:00:00+08:00',
    entries: [
      { numeric_value: '36.8', memo: 'axillary temperature' },
    ],
  }

  it('accepts a single-entry batch', () => {
    const parsed = parseNumberBatch(base)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.happenedAt.toISOString()).toBe('2026-08-05T02:00:00.000Z')
    expect(parsed.utcOffset).toBe('+08:00')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toEqual({
      numericValue: '36.8',
      objectiveContext: 'axillary temperature',
      tags: [],
      aiAnalysis: null,
    })
  })

  it('accepts multiple entries with optional tags and ai_analysis', () => {
    const parsed = parseNumberBatch({
      happened_at: base.happened_at,
      entries: [
        { numeric_value: '36.8', memo: 'first', tags: ['vitals'] },
        {
          numeric_value: '75.5',
          memo: 'second',
          ai_analysis: 'a bit heavy',
        },
      ],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.entries[0].tags).toEqual(['vitals'])
    expect(parsed.entries[0].aiAnalysis).toBeNull()
    expect(parsed.entries[1].tags).toEqual([])
    expect(parsed.entries[1].aiAnalysis).toBe('a bit heavy')
  })

  it('rejects missing happened_at', () => {
    const { happened_at: _omit, ...rest } = base
    void _omit
    expect(parseNumberBatch(rest)).toEqual({
      error: 'Missing required field: happened_at',
    })
  })

  it('rejects unknown top-level key', () => {
    expect(
      parseNumberBatch({ ...base, type: 'expense' } as unknown as Parameters<typeof parseNumberBatch>[0]),
    ).toEqual({ error: 'Unknown JSON key: type' })
  })

  it('rejects non-array / empty / oversized entries (top-level, no index)', () => {
    expect(
      parseNumberBatch({ happened_at: base.happened_at }),
    ).toEqual({ error: 'Missing required field: entries (non-empty array)' })
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [],
      }),
    ).toEqual({ error: 'entries must be a non-empty array' })
    const many = Array.from({ length: MAX_NUMBER_ENTRIES + 1 }, () => ({
      numeric_value: '1',
      memo: 'x',
    }))
    expect(
      parseNumberBatch({ happened_at: base.happened_at, entries: many }),
    ).toEqual({
      error: `entries must contain at most ${MAX_NUMBER_ENTRIES} items`,
    })
  })

  it('rejects non-object entry', () => {
    expect(
      parseNumberBatch({ happened_at: base.happened_at, entries: ['x'] }),
    ).toEqual({ error: 'entries[0] must be an object' })
  })

  it('rejects unknown entry key with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1', memo: 'x', foo: 1 }],
      }),
    ).toEqual({ error: 'entries[0]: Unknown JSON key: foo' })
  })

  it('rejects missing numeric_value with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ memo: 'x' }],
      }),
    ).toEqual({ error: 'entries[0]: Missing required field: numeric_value' })
  })

  it('rejects null numeric_value', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: null, memo: 'x' }],
      }),
    ).toEqual({ error: 'entries[0]: Missing required field: numeric_value' })
  })

  it('rejects JSON number numeric_value with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: 36.8, memo: 'x' }],
      }),
    ).toEqual({
      error: 'entries[0]: numeric_value must be a decimal string',
    })
  })

  it('rejects invalid decimal numeric_value with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1e3', memo: 'x' }],
      }),
    ).toEqual({ error: 'entries[0]: Invalid numeric_value' })
  })

  it('rejects missing or blank memo with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1' }],
      }),
    ).toEqual({ error: 'entries[0]: Missing required field: memo' })
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1', memo: '   ' }],
      }),
    ).toEqual({ error: 'entries[0]: memo must not be blank' })
  })

  it('rejects invalid tags with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1', memo: 'x', tags: ['体重'] }],
      }),
    ).toEqual({
      error:
        'entries[0]: Invalid tag: "体重". Tags must contain only letters, numbers, underscores, and cannot start with a number.',
    })
  })

  it('rejects reserved tags with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1', memo: 'x', tags: ['body:weight'] }],
      }),
    ).toEqual({
      error: 'entries[0]: tag "body:weight" is reserved; use the dedicated log API for this record type',
    })
  })

  it('rejects blank ai_analysis with index prefix', () => {
    expect(
      parseNumberBatch({
        happened_at: base.happened_at,
        entries: [{ numeric_value: '1', memo: 'x', ai_analysis: '   ' }],
      }),
    ).toEqual({ error: 'entries[0]: ai_analysis must not be blank' })
  })
})
