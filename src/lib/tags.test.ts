import { describe, expect, it } from 'vitest'
import { isValidTag, validateTags } from './tags'

describe('isValidTag', () => {
  it.each(['weight', 'source:device', 'review:weekly', 'a', 'A1_b:c2'])(
    'accepts valid tag %s',
    (tag) => {
      expect(isValidTag(tag)).toBe(true)
    },
  )

  it.each([
    '',
    '体重',
    ':device',
    'source:',
    'source::device',
    '1weight',
    'source:device:',
    'has space',
    'has-dash',
  ])('rejects invalid tag %s', (tag) => {
    expect(isValidTag(tag)).toBe(false)
  })
})

describe('validateTags', () => {
  it('rejects empty array', () => {
    expect(validateTags([])).toEqual({
      valid: false,
      error: 'tags must be a non-empty array',
    })
  })

  it('rejects non-array', () => {
    // @ts-expect-error intentional bad input
    expect(validateTags(null).valid).toBe(false)
  })

  it('rejects when any tag is invalid', () => {
    const result = validateTags(['weight', '体重'])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('体重')
  })

  it('accepts a non-empty array of valid tags', () => {
    expect(validateTags(['weight', 'source:device'])).toEqual({ valid: true })
  })
})
