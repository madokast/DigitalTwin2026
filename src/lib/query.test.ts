import { describe, expect, it } from 'vitest'
import { parseRecordQueryParams } from './query'

describe('parseRecordQueryParams from/to timezone', () => {
  it('rejects date-only from', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ from: '2026-07-30' }),
    )
    expect(result).toEqual({
      error: expect.stringMatching(/from.*timezone|timezone.*from/i),
    })
  })

  it('rejects from without timezone offset', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ from: '2026-07-30T08:00:00' }),
    )
    expect(result).toEqual({
      error: expect.stringMatching(/from.*timezone|timezone.*from/i),
    })
  })

  it('rejects to without timezone offset', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ to: '2026-07-31T00:00:00' }),
    )
    expect(result).toEqual({
      error: expect.stringMatching(/to.*timezone|timezone.*to/i),
    })
  })

  it('accepts from with Z', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ from: '2026-07-30T00:00:00Z' }),
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.conditions.length).toBeGreaterThan(0)
  })

  it('rejects lowercase z / space / non-padded from', () => {
    for (const from of [
      '2026-07-30T00:00:00z',
      '2026-07-30 00:00:00Z',
      '2026-7-30T00:00:00Z',
    ]) {
      expect(parseRecordQueryParams(new URLSearchParams({ from }))).toEqual({
        error: 'Invalid from datetime',
      })
    }
  })

  it('accepts from/to with +08:00', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({
        from: '2026-07-30T00:00:00+08:00',
        to: '2026-07-31T00:00:00+08:00',
      }),
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.conditions).toHaveLength(2)
  })

  it('accepts offset without colon (+0800)', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ from: '2026-07-30T00:00:00+0800' }),
    )
    expect('error' in result).toBe(false)
  })

  it('allows omitting from and to', () => {
    const result = parseRecordQueryParams(new URLSearchParams())
    expect(result).toEqual({
      conditions: [],
      id: null,
      page: 1,
      pageSize: 20,
    })
  })

  it('rejects oversized page integers (float precision / overflow)', () => {
    for (const page of [
      '9007199254740992', // MAX_SAFE_INTEGER + 1
      '9007199254740993', // Number() rounds
      '999999999999999999999999',
    ]) {
      expect(
        parseRecordQueryParams(new URLSearchParams({ page })),
        page,
      ).toEqual({
        error: 'page must be a positive integer',
      })
    }
  })

  it('rejects non-UUID id', () => {
    expect(
      parseRecordQueryParams(new URLSearchParams({ id: 'not-a-uuid' })),
    ).toEqual({ error: 'Invalid record id' })
    expect(
      parseRecordQueryParams(new URLSearchParams({ id: '123' })),
    ).toEqual({ error: 'Invalid record id' })
  })
})
