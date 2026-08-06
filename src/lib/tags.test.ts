import { describe, expect, it } from 'vitest'
import {
  aggregateTagCounts,
  assertNoReservedTags,
  firstDuplicateTag,
  isReservedTag,
  isValidTag,
  renameTags,
  reservedTagError,
  validateRename,
  validateTags,
} from './tags'

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
  it('accepts empty array', () => {
    expect(validateTags([])).toEqual({ valid: true })
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

describe('firstDuplicateTag', () => {
  it('returns the first duplicate tag name', () => {
    expect(firstDuplicateTag(['a', 'b', 'a'])).toBe('a')
    expect(firstDuplicateTag(['a', 'b', 'b', 'c', 'b'])).toBe('b')
  })

  it('returns null when there are no duplicates', () => {
    expect(firstDuplicateTag([])).toBeNull()
    expect(firstDuplicateTag(['a', 'b', 'c'])).toBeNull()
  })
})

describe('reserved tags', () => {
  it('treats reserved list entries as prefixes with colon boundary', () => {
    expect(isReservedTag('transaction_entry')).toBe(true)
    expect(isReservedTag('transaction_entry:income')).toBe(true)
    expect(isReservedTag('transaction_entry:expense')).toBe(true)
    expect(isReservedTag('transaction_entry:a:b')).toBe(true)
    expect(isReservedTag('transaction_entrypoint')).toBe(false)
    expect(isReservedTag('body:weight')).toBe(true)
    expect(isReservedTag('body:weight:x')).toBe(true)
    expect(isReservedTag('body:weightx')).toBe(false)
    expect(isReservedTag('todo')).toBe(true)
    expect(isReservedTag('todo:in_progress')).toBe(true)
    expect(isReservedTag('todo:completed')).toBe(true)
    expect(isReservedTag('todolist')).toBe(false)
    expect(isReservedTag('review')).toBe(true)
    expect(isReservedTag('review:weekly')).toBe(true)
    expect(isReservedTag('review:weekly:extra')).toBe(true)
    expect(isReservedTag('reviewpoint')).toBe(false)
    expect(isReservedTag('weight')).toBe(false)
  })

  it('assertNoReservedTags uses ValidationResult shape { valid, error? }', () => {
    expect(assertNoReservedTags(['weight', 'transaction_entry'])).toEqual({
      valid: false,
      error: reservedTagError('transaction_entry'),
    })
    expect(assertNoReservedTags(['transaction_entry:income'])).toEqual({
      valid: false,
      error: reservedTagError('transaction_entry:income'),
    })
    expect(assertNoReservedTags(['body:weight'])).toEqual({
      valid: false,
      error: reservedTagError('body:weight'),
    })
    expect(assertNoReservedTags(['body:weight:x'])).toEqual({
      valid: false,
      error: reservedTagError('body:weight:x'),
    })
    expect(assertNoReservedTags(['todo'])).toEqual({
      valid: false,
      error: reservedTagError('todo'),
    })
    expect(assertNoReservedTags(['todo:in_progress'])).toEqual({
      valid: false,
      error: reservedTagError('todo:in_progress'),
    })
    expect(assertNoReservedTags(['review'])).toEqual({
      valid: false,
      error: reservedTagError('review'),
    })
    expect(assertNoReservedTags(['review:weekly'])).toEqual({
      valid: false,
      error: reservedTagError('review:weekly'),
    })
    expect(assertNoReservedTags(['weight'])).toEqual({ valid: true })
    expect(assertNoReservedTags(['transaction_entrypoint'])).toEqual({
      valid: true,
    })
    expect(assertNoReservedTags(['todolist'])).toEqual({ valid: true })
    expect(assertNoReservedTags(['reviewpoint'])).toEqual({ valid: true })
  })

  it('reservedTagError uses the generic dedicated-API hint', () => {
    for (const tag of [
      'transaction_entry',
      'body:weight',
      'body:weight:morning',
      'todo',
      'todo:in_progress',
      'review',
      'review:weekly',
    ]) {
      expect(reservedTagError(tag)).toBe(
        `tag "${tag}" is reserved; use the dedicated log API for this record type`,
      )
    }
  })
})

describe('aggregateTagCounts', () => {
  it('returns empty array for no rows', () => {
    expect(aggregateTagCounts([])).toEqual([])
  })

  it('counts tags and sorts by count desc, then tag name asc', () => {
    const result = aggregateTagCounts([
      JSON.stringify(['weight', 'morning']),
      JSON.stringify(['study', 'physics']),
      JSON.stringify(['weight']),
    ])
    expect(result).toEqual([
      { tag: 'weight', count: 2 },
      { tag: 'morning', count: 1 },
      { tag: 'physics', count: 1 },
      { tag: 'study', count: 1 },
    ])
  })

  it('ties break by tag name byte order (uppercase before lowercase)', () => {
    const result = aggregateTagCounts([
      JSON.stringify(['weight', 'Weight', 'apple', 'Apple']),
    ])
    expect(result).toEqual([
      { tag: 'Apple', count: 1 },
      { tag: 'Weight', count: 1 },
      { tag: 'apple', count: 1 },
      { tag: 'weight', count: 1 },
    ])
  })

  it('filters by true prefix when prefix is given', () => {
    const result = aggregateTagCounts(
      [
        JSON.stringify(['body:weight', 'body:weight']),
        JSON.stringify(['workout:arm']),
        JSON.stringify(['morning']),
      ],
      'body:',
    )
    expect(result).toEqual([{ tag: 'body:weight', count: 2 }])
  })

  it('treats "*" in prefix literally (no wildcard parsing)', () => {
    // `*` 不是合法 tag 字符 → 没有任何 tag 以字面 `*` 开头；
    // 若被当通配则会返回全部 tag。断言返回空即证明未做通配解析。
    const result = aggregateTagCounts(
      [
        JSON.stringify(['workout:arm']),
        JSON.stringify(['morning']),
      ],
      '*',
    )
    expect(result).toEqual([])
  })

  it('skips dirty JSON rows (invalid JSON / non-array root)', () => {
    expect(aggregateTagCounts(['not-json'])).toEqual([])
    expect(aggregateTagCounts(['{}'])).toEqual([])
    expect(aggregateTagCounts(['null'])).toEqual([])
    expect(aggregateTagCounts(['"weight"'])).toEqual([])
  })
})

describe('renameTags', () => {
  it('renames from to when to absent, order preserved', () => {
    expect(renameTags(['a', 'work', 'b'], 'work', 'job')).toEqual(['a', 'job', 'b'])
  })

  it('removes from when to already exists (dedupe)', () => {
    expect(renameTags(['job', 'work', 'x'], 'work', 'job')).toEqual(['job', 'x'])
    expect(renameTags(['work', 'job'], 'work', 'job')).toEqual(['job'])
  })

  it('returns null when from is absent', () => {
    expect(renameTags(['alpha'], 'weight', 'mass')).toBeNull()
    expect(renameTags([], 'weight', 'mass')).toBeNull()
  })
})

describe('validateRename', () => {
  it('rejects empty from or to', () => {
    expect(validateRename('', 'to_tag')).toEqual({
      valid: false,
      error: 'missing required fields: from, to',
    })
    expect(validateRename('from_tag', '')).toEqual({
      valid: false,
      error: 'missing required fields: from, to',
    })
  })

  it('rejects invalid tag names', () => {
    expect(validateRename('bad-tag', 'ok')).toEqual({
      valid: false,
      error: 'from and to must be valid tag names',
    })
  })

  it('rejects reserved from/to (from preferred when both reserved)', () => {
    expect(validateRename('transaction_entry', 'weight')).toEqual({
      valid: false,
      error: reservedTagError('transaction_entry'),
    })
    expect(validateRename('weight', 'transaction_entry:income')).toEqual({
      valid: false,
      error: reservedTagError('transaction_entry:income'),
    })
    expect(validateRename('todo', 'errand')).toEqual({
      valid: false,
      error: reservedTagError('todo'),
    })
    expect(validateRename('errand', 'todo:in_progress')).toEqual({
      valid: false,
      error: reservedTagError('todo:in_progress'),
    })
    expect(validateRename('review', 'insight')).toEqual({
      valid: false,
      error: reservedTagError('review'),
    })
    expect(validateRename('insight', 'review:weekly')).toEqual({
      valid: false,
      error: reservedTagError('review:weekly'),
    })
  })

  it('rejects when from equals to', () => {
    expect(validateRename('weight', 'weight')).toEqual({
      valid: false,
      error: 'from and to must be different',
    })
  })

  it('accepts a valid rename pair', () => {
    expect(validateRename('exercise', 'workout')).toEqual({ valid: true })
  })
})
