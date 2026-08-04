import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  INVALID_CADENCE_MESSAGE,
  MISSING_CADENCE_MESSAGE,
  REVIEW_CADENCES,
  parseReview,
  reviewTagsForCadence,
} from './reviewdraft'
import { reservedTagError } from './tags'

const cadenceCases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/review-cadence-cases.json',
    ),
    'utf8',
  ),
) as {
  cadences: string[]
  missing_message: string
  invalid_message: string
  missing: unknown[]
  invalid: string[]
}

const validBase = {
  happened_at: '2026-08-09T19:00:00+08:00',
  cadence: 'weekly',
  raw_content: 'This week I slept better and finished the report.',
  objective_context: 'Weekly review covering 2026-08-03..2026-08-09',
  ai_analysis: 'Deeper work in the morning helped.',
  tags: ['work'],
}

describe('cadence fixtures', () => {
  it('constants stay byte-identical to shared fixture', () => {
    expect(REVIEW_CADENCES).toEqual(cadenceCases.cadences)
    expect(MISSING_CADENCE_MESSAGE).toBe(cadenceCases.missing_message)
    expect(INVALID_CADENCE_MESSAGE).toBe(cadenceCases.invalid_message)
  })

  it('accepts every cadence in the enum', () => {
    for (const cadence of cadenceCases.cadences) {
      const parsed = parseReview({ ...validBase, cadence })
      expect('error' in parsed, cadence).toBe(false)
      if (!('error' in parsed)) expect(parsed.cadence).toBe(cadence)
    }
  })

  it('rejects missing cadence', () => {
    for (const cadence of cadenceCases.missing) {
      const parsed = parseReview({ ...validBase, cadence })
      expect(parsed, JSON.stringify(cadence)).toEqual({
        error: MISSING_CADENCE_MESSAGE,
      })
    }
  })

  it('rejects invalid cadence values (case / whitespace / unknown)', () => {
    for (const cadence of cadenceCases.invalid) {
      const parsed = parseReview({ ...validBase, cadence })
      expect(parsed, JSON.stringify(cadence)).toEqual({
        error: INVALID_CADENCE_MESSAGE,
      })
    }
  })
})

describe('parseReview', () => {
  it('normalizes a valid weekly review', () => {
    const parsed = parseReview(validBase)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.happenedAt).toBeInstanceOf(Date)
    expect(parsed.utcOffset).toBe('+08:00')
    expect(parsed.cadence).toBe('weekly')
    expect(parsed.rawContent).toBe(validBase.raw_content)
    expect(parsed.objectiveContext).toBe(validBase.objective_context)
    expect(parsed.aiAnalysis).toBe(validBase.ai_analysis)
    expect(parsed.tags).toEqual(['work'])
  })

  it('accepts omitted / empty / null tags and ai_analysis', () => {
    for (const tags of [undefined, null, []]) {
      const parsed = parseReview({ ...validBase, tags })
      expect('error' in parsed, JSON.stringify(tags)).toBe(false)
      if (!('error' in parsed)) expect(parsed.tags).toEqual([])
    }
    const noAi = parseReview({ ...validBase, ai_analysis: undefined })
    expect('error' in noAi).toBe(false)
    if (!('error' in noAi)) expect(noAi.aiAnalysis).toBeNull()
  })

  it('trims raw_content / objective_context / ai_analysis', () => {
    const parsed = parseReview({
      ...validBase,
      raw_content: '  text  ',
      objective_context: '  ctx  ',
      ai_analysis: '  note  ',
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.rawContent).toBe('text')
    expect(parsed.objectiveContext).toBe('ctx')
    expect(parsed.aiAnalysis).toBe('note')
  })

  it('rejects blank raw_content / objective_context / ai_analysis', () => {
    for (const [key, value, want] of [
      ['raw_content', '', 'Missing required field: raw_content'],
      ['raw_content', '   ', 'raw_content must not be blank'],
      ['objective_context', '', 'Missing required field: objective_context'],
      ['objective_context', '   ', 'objective_context must not be blank'],
      ['ai_analysis', '   ', 'ai_analysis must not be blank'],
    ] as const) {
      const parsed = parseReview({ ...validBase, [key]: value })
      expect(parsed, key).toEqual({ error: want })
    }
  })

  it('rejects happened_at without timezone', () => {
    const parsed = parseReview({ ...validBase, happened_at: '2026-08-09T19:00:00' })
    expect(parsed).toEqual({
      error: 'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
  })

  it('rejects numeric_value / utc_offset as unknown keys', () => {
    expect(
      parseReview({
        ...validBase,
        // @ts-expect-error intentional unknown key
        numeric_value: '1',
      }),
    ).toEqual({ error: 'Unknown JSON key: numeric_value' })
    expect(
      parseReview({
        ...validBase,
        // @ts-expect-error intentional unknown key
        utc_offset: '+08:00',
      }),
    ).toEqual({ error: 'Unknown JSON key: utc_offset' })
  })

  it('rejects reserved review / review:* tags from client', () => {
    expect(parseReview({ ...validBase, tags: ['review'] })).toEqual({
      error: reservedTagError('review'),
    })
    expect(parseReview({ ...validBase, tags: ['review:weekly'] })).toEqual({
      error: reservedTagError('review:weekly'),
    })
  })

  it('rejects invalid tags', () => {
    const parsed = parseReview({ ...validBase, tags: ['体重'] })
    expect('error' in parsed).toBe(true)
    if (!('error' in parsed)) return
    expect(parsed.error).toContain('Invalid tag')
  })

  it('rejects non-string tags element', () => {
    expect(
      parseReview({
        ...validBase,
        tags: ['work', 1],
      }),
    ).toEqual({ error: 'tags must be an array of strings' })
  })
})

describe('reviewTagsForCadence', () => {
  it('prepends review:{cadence} and keeps client tags in order', () => {
    expect(reviewTagsForCadence('weekly', ['work', 'sleep'])).toEqual([
      'review:weekly',
      'work',
      'sleep',
    ])
    expect(reviewTagsForCadence('semiannually', [])).toEqual([
      'review:semiannually',
    ])
  })
})
