import { describe, expect, it } from 'vitest'
import {
  BODY_MUST_BE_OBJECT,
  UNKNOWN_JSON_KEY_PREFIX,
  rejectUnknownKeys,
} from './unknown-keys'

describe('rejectUnknownKeys', () => {
  const allowed = ['a', 'b'] as const

  it('accepts only allowed keys', () => {
    expect(rejectUnknownKeys({ a: 1 }, allowed)).toBeNull()
    expect(rejectUnknownKeys({ a: 1, b: 2 }, allowed)).toBeNull()
    expect(rejectUnknownKeys({}, allowed)).toBeNull()
  })

  it('rejects unknown key with stable message', () => {
    expect(rejectUnknownKeys({ a: 1, z: 9 }, allowed)).toEqual({
      error: `${UNKNOWN_JSON_KEY_PREFIX}z`,
    })
    expect(rejectUnknownKeys({ z: 1, m: 2 }, allowed)).toEqual({
      error: `${UNKNOWN_JSON_KEY_PREFIX}m`,
    })
  })

  it('rejects non-objects', () => {
    expect(rejectUnknownKeys(null, allowed)).toEqual({
      error: BODY_MUST_BE_OBJECT,
    })
    expect(rejectUnknownKeys([], allowed)).toEqual({
      error: BODY_MUST_BE_OBJECT,
    })
    expect(rejectUnknownKeys('x', allowed)).toEqual({
      error: BODY_MUST_BE_OBJECT,
    })
  })
})
