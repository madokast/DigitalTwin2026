import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reservedTagError } from './tags'
import {
  parseTodo,
  toTodoRecordJson,
  TODO_TAG_IN_PROGRESS,
  type TodoRecordJson,
} from './tododraft'
import type { Record } from './record'

const deformFixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/todo-record-deform.json',
    ),
    'utf8',
  ),
) as {
  inputRecord: Record
  todoRecordJson: TodoRecordJson
}

describe('toTodoRecordJson shared fixture', () => {
  it('maps happenedAt/valueText to created_at/content', () => {
    expect(toTodoRecordJson(deformFixture.inputRecord)).toEqual(
      deformFixture.todoRecordJson,
    )
  })
})

describe('parseTodo', () => {
  const base = {
    created_at: '2026-08-02T10:00:00+08:00',
    content: 'Buy milk',
    objective_context: 'weekend grocery list',
  }

  it('prepends todo:in_progress and maps aliases', () => {
    const parsed = parseTodo({
      ...base,
      subjective_interpretation: 'need it for breakfast',
      tags: ['errand'],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.valueText).toBe('Buy milk')
    expect(parsed.tags).toEqual([TODO_TAG_IN_PROGRESS, 'errand'])
    expect(parsed.objectiveContext).toBe('weekend grocery list')
    expect(parsed.subjectiveInterpretation).toBe('need it for breakfast')
    expect(parsed.happenedAt.toISOString()).toBe('2026-08-02T02:00:00.000Z')
  })

  it('allows omitted or empty tags (only todo:in_progress)', () => {
    const a = parseTodo(base)
    expect('error' in a).toBe(false)
    if ('error' in a) return
    expect(a.tags).toEqual([TODO_TAG_IN_PROGRESS])

    const b = parseTodo({ ...base, tags: [] })
    expect('error' in b).toBe(false)
    if ('error' in b) return
    expect(b.tags).toEqual([TODO_TAG_IN_PROGRESS])
  })

  it('rejects missing created_at / content / objective_context', () => {
    expect(parseTodo({ content: 'x', objective_context: 'y' })).toEqual({
      error: 'Missing required field: created_at',
    })
    expect(parseTodo({ created_at: base.created_at, objective_context: 'y' })).toEqual({
      error: 'Missing required field: content',
    })
    expect(parseTodo({ created_at: base.created_at, content: 'x' })).toEqual({
      error: 'Missing required field: objective_context',
    })
    expect(
      parseTodo({ ...base, content: '' }),
    ).toEqual({ error: 'Missing required field: content' })
  })

  it('rejects created_at without timezone using created_at wording', () => {
    expect(
      parseTodo({ ...base, created_at: '2026-08-02T10:00:00' }),
    ).toEqual({
      error: 'created_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    })
  })

  it('rejects reserved client tags', () => {
    expect(parseTodo({ ...base, tags: ['todo:in_progress'] })).toEqual({
      error: reservedTagError('todo:in_progress'),
    })
    expect(parseTodo({ ...base, tags: ['todo'] })).toEqual({
      error: reservedTagError('todo'),
    })
  })

  it('rejects happened_at / value_text as unknown keys', () => {
    expect(
      parseTodo({ ...base, happened_at: base.created_at } as typeof base & {
        happened_at: string
      }),
    ).toEqual({ error: 'Unknown JSON key: happened_at' })
    expect(
      parseTodo({ ...base, value_text: 'x' } as typeof base & {
        value_text: string
      }),
    ).toEqual({ error: 'Unknown JSON key: value_text' })
  })
})
