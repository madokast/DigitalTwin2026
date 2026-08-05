import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reservedTagError } from './tags'
import {
  auditObjectiveContext,
  todoAuditNotifyText,
  ERR_INVALID_TARGET,
  isTodoAuditRecordTags,
  parseTodo,
  parseTodoTransition,
  replaceTodoStateInTags,
  shouldDeformTodoRecordTags,
  toTodoRecordJson,
  TODO_TAG_IN_PROGRESS,
  TODO_TAG_TRANSITION,
  todoStateFromTags,
  type TodoRecordJson,
  type TodoState,
} from './tododraft'
import type { Record } from './record'
import { toQueryRecordJson } from './query'

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
  it('maps happenedAt/rawContent to created_at/content', () => {
    expect(toTodoRecordJson(deformFixture.inputRecord)).toEqual(
      deformFixture.todoRecordJson,
    )
  })

  it('preserves offset on created_at (deform is key-only, §6.1)', () => {
    const withOffset = {
      ...deformFixture.inputRecord,
      happened_at: '2026-08-02T10:00:00.000+08:00',
    }
    expect(toTodoRecordJson(withOffset).created_at).toBe(
      '2026-08-02T10:00:00.000+08:00',
    )
  })
})

const queryDeformFixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/todo-query-deform-cases.json',
    ),
    'utf8',
  ),
) as {
  cases: Array<{ name: string; tags: string[]; deform: boolean }>
}

describe('shouldDeformTodoRecordTags shared fixture', () => {
  it('matches query-side wide rule for all cases', () => {
    for (const c of queryDeformFixture.cases) {
      expect(shouldDeformTodoRecordTags(c.tags), c.name).toBe(c.deform)
    }
  })
})

describe('toQueryRecordJson', () => {
  it('deforms todo rows and keeps audit / plain as Record', () => {
    const todo = toQueryRecordJson(deformFixture.inputRecord)
    expect(todo).toEqual(deformFixture.todoRecordJson)
    expect('happened_at' in todo).toBe(false)
    expect('raw_content' in todo).toBe(false)

    const audit: Record = {
      ...deformFixture.inputRecord,
      raw_content: 'Buy milk',
      tags: [TODO_TAG_TRANSITION],
      objective_context:
        'Complete a to-do 01900000-0000-7000-8000-000000000003 created at 2026-08-02T02:00:00.000Z',
      ai_analysis: null,
    }
    const auditJson = toQueryRecordJson(audit)
    expect(auditJson).toEqual(audit)
    expect('created_at' in auditJson).toBe(false)
    expect('content' in auditJson).toBe(false)

    const dirty: Record = {
      ...deformFixture.inputRecord,
      tags: ['todo:completed', TODO_TAG_TRANSITION],
    }
    const dirtyJson = toQueryRecordJson(dirty)
    expect(dirtyJson).toMatchObject({
      created_at: dirty.happened_at,
      content: dirty.raw_content,
    })
    expect('happened_at' in dirtyJson).toBe(false)
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
      ai_analysis: 'need it for breakfast',
      tags: ['errand'],
    })
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.rawContent).toBe('Buy milk')
    expect(parsed.tags).toEqual([TODO_TAG_IN_PROGRESS, 'errand'])
    expect(parsed.objectiveContext).toBe('weekend grocery list')
    expect(parsed.aiAnalysis).toBe('need it for breakfast')
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

  it('rejects duplicate client tags', () => {
    expect(parseTodo({ ...base, tags: ['errand', 'errand'] })).toEqual({
      error: 'Duplicate tag "errand"',
    })
  })

  it('rejects happened_at / raw_content as unknown keys', () => {
    expect(
      parseTodo({ ...base, happened_at: base.created_at } as typeof base & {
        happened_at: string
      }),
    ).toEqual({ error: 'Unknown JSON key: happened_at' })
    expect(
      parseTodo({ ...base, raw_content: 'x' } as typeof base & {
        raw_content: string
      }),
    ).toEqual({ error: 'Unknown JSON key: raw_content' })
  })
})

const auditFixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../testdata/todo-transition-audit.json',
    ),
    'utf8',
  ),
) as {
  cases: Array<{
    target: TodoState
    todoId: string
    todoHappenedAt: string
    todoRawContent: string
    objective_context: string
    notify_text: string
  }>
}

describe('todoAuditNotifyText shared fixture', () => {
  it('matches §3.1 notify templates for all targets', () => {
    for (const c of auditFixture.cases) {
      expect(
        todoAuditNotifyText(
          c.target,
          c.todoId,
          c.todoHappenedAt,
          c.todoRawContent,
        ),
      ).toBe(c.notify_text)
    }
  })

  it('builds audit objective_context with verb, todo id and time', () => {
    for (const c of auditFixture.cases) {
      expect(
        auditObjectiveContext(c.target, c.todoId, c.todoHappenedAt),
      ).toBe(c.objective_context)
    }
  })
})

describe('todo transition tag helpers', () => {
  it('detects audit vs strict todo and replaces state', () => {
    expect(isTodoAuditRecordTags([TODO_TAG_TRANSITION])).toBe(true)
    expect(isTodoAuditRecordTags([TODO_TAG_IN_PROGRESS])).toBe(false)
    expect(todoStateFromTags([TODO_TAG_IN_PROGRESS, 'errand'])).toBe(
      'in_progress',
    )
    expect(
      replaceTodoStateInTags([TODO_TAG_IN_PROGRESS, 'errand'], 'completed'),
    ).toEqual(['todo:completed', 'errand'])
  })
})

describe('parseTodoTransition', () => {
  const base = {
    id: '01900000-0000-7000-8000-000000000003',
    target: 'completed',
    happened_at: '2026-08-02T12:00:00+08:00',
  }

  it('accepts valid transition body', () => {
    const parsed = parseTodoTransition(base)
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.id).toBe(base.id)
    expect(parsed.target).toBe('completed')
    expect(parsed.happenedAt.toISOString()).toBe('2026-08-02T04:00:00.000Z')
  })

  it('rejects missing fields / invalid target / unknown keys', () => {
    expect(parseTodoTransition({ ...base, id: undefined })).toEqual({
      error: 'Missing required field: id',
    })
    expect(parseTodoTransition({ ...base, target: undefined })).toEqual({
      error: 'Missing required field: target',
    })
    expect(parseTodoTransition({ ...base, happened_at: undefined })).toEqual({
      error: 'Missing required field: happened_at',
    })
    expect(parseTodoTransition({ ...base, target: 'done' })).toEqual({
      error: ERR_INVALID_TARGET,
    })
    expect(
      parseTodoTransition({
        ...base,
        created_at: base.happened_at,
      } as typeof base & { created_at: string }),
    ).toEqual({ error: 'Unknown JSON key: created_at' })
  })
})
