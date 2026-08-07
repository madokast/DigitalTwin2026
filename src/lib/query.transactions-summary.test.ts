import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TransactionsSummaryAcc,
  parseTransactionsSummaryParams,
} from './query'

type SharedCases = {
  cases: Array<{
    name: string
    from: string
    to: string
    rows: Array<{ tags: string; numeric_value: string | null }>
    expected: unknown
  }>
  parse_errors: Array<{
    name: string
    query: Record<string, string>
    error: string
  }>
}

function loadCases(): SharedCases {
  const root = path.join(__dirname, '../..')
  return JSON.parse(
    readFileSync(
      path.join(root, 'testdata/transaction-summary-cases.json'),
      'utf8',
    ),
  ) as SharedCases
}

describe('parseTransactionsSummaryParams (shared fixtures)', () => {
  const { parse_errors } = loadCases()

  for (const tc of parse_errors) {
    it(tc.name, () => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(tc.query)) {
        params.set(k, v)
      }
      expect(parseTransactionsSummaryParams(params)).toEqual({
        error: tc.error,
      })
    })
  }

  it('accepts valid from/to', () => {
    const result = parseTransactionsSummaryParams(
      new URLSearchParams({
        from: '2026-07-01T00:00:00+08:00',
        to: '2026-08-01T00:00:00+08:00',
      }),
    )
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.fromRaw).toBe('2026-07-01T00:00:00+08:00')
    expect(result.toRaw).toBe('2026-08-01T00:00:00+08:00')
    expect(result.from.getTime()).toBeLessThan(result.to.getTime())
  })
})

function aggregateFixture(
  rows: Array<{ tags: string; numeric_value: string | null }>,
  from: string,
  to: string,
) {
  const acc = new TransactionsSummaryAcc()
  for (const r of rows) {
    const parsed: unknown = JSON.parse(r.tags)
    if (!Array.isArray(parsed)) throw new Error('fixture tags not array')
    acc.addRow(
      parsed.filter((t): t is string => typeof t === 'string'),
      r.numeric_value,
    )
  }
  return acc.finalize(from, to)
}

describe('TransactionsSummaryAcc (shared fixtures)', () => {
  const { cases } = loadCases()

  for (const tc of cases) {
    it(tc.name, () => {
      const got = aggregateFixture(tc.rows, tc.from, tc.to)
      expect(got).toEqual(tc.expected)
    })
  }

  it('all money fields are exactly two decimal strings', () => {
    const money2 = /^-?(?:0|[1-9]\d*)\.\d{2}$/
    for (const tc of cases) {
      const got = aggregateFixture(tc.rows, tc.from, tc.to)
      expect(got.income.sum).toMatch(money2)
      expect(got.expense.sum).toMatch(money2)
      expect(got.net).toMatch(money2)
      for (const cat of [...got.income_categories, ...got.expense_categories]) {
        expect(cat.sum).toMatch(money2)
        for (const sub of cat.subcategories) {
          expect(sub.sum).toMatch(money2)
        }
      }
    }
  })
})
