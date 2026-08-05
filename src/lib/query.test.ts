import { describe, expect, it } from 'vitest'
import { and } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRecordQueryParams, recordsOrderBySql } from './query'

const dialect = new PgDialect()

function whereSQL(params: URLSearchParams): string {
  const result = parseRecordQueryParams(params)
  expect('error' in result).toBe(false)
  if ('error' in result) throw new Error(result.error)
  const where = and(...result.conditions)
  if (!where) throw new Error('expected conditions')
  return dialect.sqlToQuery(where).sql
}

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
        error: 'invalid from datetime',
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
      sortBy: 'happened_at',
      sortOrder: 'asc',
      hint: undefined,
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
    ).toEqual({ error: 'invalid record id' })
    expect(
      parseRecordQueryParams(new URLSearchParams({ id: '123' })),
    ).toEqual({ error: 'invalid record id' })
  })

  it('rejects UUID-shaped ids with illegal version/variant', () => {
    expect(
      parseRecordQueryParams(
        new URLSearchParams({ id: 'a0eebc99-9c0b-4ef8-7000-6bb9bd380a11' }),
      ),
    ).toEqual({ error: 'invalid record id' })
    expect(
      parseRecordQueryParams(
        new URLSearchParams({
          id: '01234567-89ab-cdef-0123-456789abcdef',
        }),
      ),
    ).toEqual({ error: 'invalid record id' })
  })
})

describe('parseRecordQueryParams q OR grouping', () => {
  it('parenthesizes q OR when combined with tag (AND binds tighter than OR)', () => {
    const sql = whereSQL(new URLSearchParams({ q: 'foo', tag: 'x' }))
    // 必须是 tag AND (vt OR obj OR subj OR tags)，不能是 (tag AND vt) OR obj OR ...
    expect(sql).toMatch(
      /like \$1 and \("records"\."raw_content" like \$2 or "records"\."objective_context" like \$3 or "records"\."ai_analysis" like \$4 or "records"\."tags" like \$5\)/i,
    )
    expect(sql).not.toMatch(
      /like \$1 and "records"\."raw_content" like \$2 or "records"\."objective_context"/i,
    )
  })

  it('parenthesizes q OR when combined with from', () => {
    const sql = whereSQL(
      new URLSearchParams({
        q: 'foo',
        from: '2026-07-30T00:00:00Z',
      }),
    )
    expect(sql).toMatch(
      /and \("records"\."raw_content" like .+ or "records"\."objective_context" like .+ or "records"\."ai_analysis" like .+ or "records"\."tags" like .+\)/i,
    )
  })
})

describe('parseRecordQueryParams tag query (shared with Go)', () => {
  const shared = JSON.parse(
    readFileSync(join(process.cwd(), 'testdata', 'tag-query-cases.json'), 'utf8'),
  ) as {
    cases: Array<{
      name: string
      tag: string
      valid: boolean
      pattern: string
      hint: string
      error: string
    }>
  }

  it('matches testdata/tag-query-cases.json', () => {
    for (const c of shared.cases) {
      const result = parseRecordQueryParams(new URLSearchParams({ tag: c.tag }))
      if (!c.valid) {
        expect('error' in result, c.name).toBe(true)
        if ('error' in result) {
          expect(result.error, c.name).toBe(c.error)
        }
        continue
      }
      expect('error' in result, c.name).toBe(false)
      if ('error' in result) continue
      expect(result.hint, c.name).toBe(c.hint === '' ? undefined : c.hint)
      // 单 tag → 恰一个条件；pattern 经 drizzle 参数化后落入 params
      expect(result.conditions, c.name).toHaveLength(1)
      const where = and(...result.conditions)
      expect(where, c.name).toBeTruthy()
      const { params } = dialect.sqlToQuery(where!)
      expect(params, c.name).toEqual([c.pattern])
    }
  })

  it('first bare reserved prefix wins the hint', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams('tag=review&tag=todo&tag=work'),
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.hint).toMatch(/^Use "tag=review:\*"/)
    expect(result.conditions).toHaveLength(3)
  })

  it('wildcard tag does not produce a hint', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ tag: 'review:*' }),
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.hint).toBeUndefined()
  })

  it('escapes literal _ in the family prefix', () => {
    const result = parseRecordQueryParams(
      new URLSearchParams({ tag: 'foo_bar:*' }),
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.conditions).toHaveLength(1)
    const where = and(...result.conditions)
    expect(where).toBeTruthy()
    const { params } = dialect.sqlToQuery(where!)
    expect(params).toEqual(['%"foo\\_bar:%'])
  })
})

describe('recordsOrderBySql (shared with Go)', () => {
  it('matches testdata/query-records-list-order.json for all four combos', () => {
    const shared = JSON.parse(
      readFileSync(
        join(process.cwd(), 'testdata', 'query-records-list-order.json'),
        'utf8',
      ),
    ) as { orders: Record<string, string> }
    expect(recordsOrderBySql('happened_at', 'asc')).toBe(
      shared.orders['happened_at+asc'],
    )
    expect(recordsOrderBySql('happened_at', 'desc')).toBe(
      shared.orders['happened_at+desc'],
    )
    expect(recordsOrderBySql('id', 'asc')).toBe(shared.orders['id+asc'])
    expect(recordsOrderBySql('id', 'desc')).toBe(shared.orders['id+desc'])
  })
})
