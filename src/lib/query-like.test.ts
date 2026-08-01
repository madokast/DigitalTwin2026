import { describe, expect, it } from 'vitest'
import { escapeLikePattern } from './query'

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards and backslash for literal match', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('a_%\\x')).toBe('a\\_\\%\\\\x')
    expect(escapeLikePattern('plain')).toBe('plain')
  })
})
