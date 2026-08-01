import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INVALID_WEIGHT,
  parseBodyWeight,
  parseWeightAmount,
} from './bodyweightdraft'
import { VALUE_NUMBER_MUST_BE_STRING } from './draft'
import { reservedTagError } from './tags'

const weightCases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/weight-amount-cases.json',
    ),
    'utf8',
  ),
) as {
  invalidWeightError: string
  valueNumberMustBeString: string
  accept: { input: string; stored: string }[]
  reject: { input: string; error: string }[]
}

describe('parseWeightAmount shared fixtures', () => {
  it('matches fixture error constants', () => {
    expect(INVALID_WEIGHT).toBe(weightCases.invalidWeightError)
    expect(VALUE_NUMBER_MUST_BE_STRING).toBe(weightCases.valueNumberMustBeString)
  })

  it.each(weightCases.accept)('accepts $input → $stored', ({ input, stored }) => {
    expect(parseWeightAmount(input)).toEqual({ ok: true, value: stored })
  })

  it.each(weightCases.reject)('rejects $input', ({ input, error }) => {
    expect(parseWeightAmount(input)).toEqual({ error })
  })

  it('rejects JSON number with value_number must be a decimal string', () => {
    expect(parseWeightAmount(75.5)).toEqual({
      error: VALUE_NUMBER_MUST_BE_STRING,
    })
  })
})

describe('parseBodyWeight', () => {
  const base = {
    happened_at: '2026-08-02T08:00:00+08:00',
    value_number: '75.5',
    objective_context: 'morning weigh-in',
  }

  it('prepends body:weight and normalizes value', () => {
    const parsed = parseBodyWeight({
      ...base,
      subjective_interpretation: 'a bit heavy',
      tags: ['morning'],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.valueNumber).toBe('75.50')
    expect(parsed.tags).toEqual(['body:weight', 'morning'])
    expect(parsed.objectiveContext).toBe('morning weigh-in')
    expect(parsed.subjectiveInterpretation).toBe('a bit heavy')
  })

  it('allows omitted or empty tags (only body:weight)', () => {
    const a = parseBodyWeight(base)
    expect('error' in a).toBe(false)
    if ('error' in a) return
    expect(a.tags).toEqual(['body:weight'])

    const b = parseBodyWeight({ ...base, tags: [] })
    expect('error' in b).toBe(false)
    if ('error' in b) return
    expect(b.tags).toEqual(['body:weight'])
  })

  it('rejects reserved client tags', () => {
    expect(
      parseBodyWeight({ ...base, tags: ['body:weight'] }),
    ).toEqual({ error: reservedTagError('body:weight') })
    expect(
      parseBodyWeight({ ...base, tags: ['body:weight:x'] }),
    ).toEqual({ error: reservedTagError('body:weight:x') })
    expect(
      parseBodyWeight({ ...base, tags: ['transaction_entry'] }),
    ).toEqual({ error: reservedTagError('transaction_entry') })
  })

  it('rejects unknown keys', () => {
    expect(
      parseBodyWeight({ ...base, unit: 'kg' } as typeof base & { unit: string }),
    ).toEqual({ error: 'Unknown JSON key: unit' })
  })
})
