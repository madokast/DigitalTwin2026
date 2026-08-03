import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertNoReservedTags } from './tags'
import {
  formatLineError,
  INVALID_JSON_LINE,
  parseLine,
  serializeLine,
} from './recordjsonl'

type ValidCase = {
  name: string
  line: string
  expectTags: string[]
  expectValueNumber: string | null
  expectValueText: string | null
  expectObjectiveContext: string
  expectSubjectiveInterpretation: string | null
  expectHappenedAtUtcMs: number
  serialized: string
}

type InvalidCase = {
  name: string
  line: string
  error: string
}

const cases = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/record-jsonl-cases.json',
    ),
    'utf8',
  ),
) as {
  valid: ValidCase[]
  invalid: InvalidCase[]
  withLineNumber: { lineNumber: number; line: string; error: string }
}

describe('formatLineError', () => {
  it('prefixes 1-based line numbers', () => {
    expect(formatLineError('boom', 3)).toBe('line 3: boom')
  })

  it('leaves message alone when lineNumber omitted or <1', () => {
    expect(formatLineError('boom')).toBe('boom')
    expect(formatLineError('boom', 0)).toBe('boom')
  })
})

describe('parseLine valid', () => {
  it.each(cases.valid)('$name', (c) => {
    const got = parseLine(c.line)
    expect('error' in got, JSON.stringify(got)).toBe(false)
    if ('error' in got) return
    expect(got.tags).toEqual(c.expectTags)
    expect(got.valueNumber).toBe(c.expectValueNumber)
    expect(got.valueText).toBe(c.expectValueText)
    expect(got.objectiveContext).toBe(c.expectObjectiveContext)
    expect(got.subjectiveInterpretation).toBe(
      c.expectSubjectiveInterpretation,
    )
    expect(got.happenedAt.getTime()).toBe(c.expectHappenedAtUtcMs)
    expect(serializeLine(got)).toBe(c.serialized)
  })

  it('reserved tags pass parse; assertNoReservedTags still rejects', () => {
    const reserved = cases.valid.find(
      (c) => c.name === 'reserved-todo-tag-passes-parse',
    )
    expect(reserved).toBeTruthy()
    const got = parseLine(reserved!.line)
    expect('error' in got).toBe(false)
    if ('error' in got) return
    expect(assertNoReservedTags(got.tags).valid).toBe(false)
  })

  it('strips UTF-8 BOM', () => {
    const base = cases.valid[0]!
    const got = parseLine(`\uFEFF${base.line}`)
    expect('error' in got).toBe(false)
  })
})

describe('parseLine invalid', () => {
  it.each(cases.invalid)('$name → $error', (c) => {
    expect(parseLine(c.line)).toEqual({ error: c.error })
  })

  it('wraps error with line number', () => {
    const w = cases.withLineNumber
    expect(parseLine(w.line, w.lineNumber)).toEqual({ error: w.error })
  })

  it('rejects empty line', () => {
    expect(parseLine('')).toEqual({ error: INVALID_JSON_LINE })
    expect(parseLine('   ')).toEqual({ error: INVALID_JSON_LINE })
  })
})

describe('serializeLine round-trip', () => {
  it('parse → serialize → parse preserves domain fields', () => {
    for (const c of cases.valid) {
      const once = parseLine(c.line)
      expect('error' in once).toBe(false)
      if ('error' in once) return
      const line = serializeLine(once)
      const twice = parseLine(line)
      expect('error' in twice).toBe(false)
      if ('error' in twice) return
      expect(twice.id).toBe(once.id)
      expect(twice.happenedAt.getTime()).toBe(once.happenedAt.getTime())
      expect(twice.utcOffset).toBe(once.utcOffset)
      expect(twice.valueNumber).toBe(once.valueNumber)
      expect(twice.valueText).toBe(once.valueText)
      expect(twice.tags).toEqual(once.tags)
      expect(twice.objectiveContext).toBe(once.objectiveContext)
      expect(twice.subjectiveInterpretation).toBe(
        once.subjectiveInterpretation,
      )
    }
  })
})
