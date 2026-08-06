import { describe, expect, it } from 'vitest'
import { createText } from '@/lib/logapi'
import { reservedTagError } from '@/lib/tags'

/** 决策 D：业务函数失败 throw MyError（status + message）。 */
const rejects = async (
  p: Promise<unknown>,
  status: number,
  message: string,
) => {
  await expect(p).rejects.toMatchObject({ status, message })
}

describe('createText', () => {
  it('rejects whitespace-only raw_content', async () => {
    for (const raw of ['', '   ', '\t']) {
      await rejects(
        createText({
          happened_at: '2026-07-30T10:00:00Z',
          raw_content: raw,
          tags: ['study'],
          objective_context: 'x',
        }),
        400,
        raw === '' ? 'missing required field: raw_content' : 'raw_content must not be blank',
      )
    }
  })

  it('rejects happened_at without timezone', async () => {
    await rejects(
      createText({
        happened_at: '2026-07-30T10:00:00',
        raw_content: 'hello',
        tags: ['study'],
        objective_context: 'x',
      }),
      400,
      'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
    )
  })

  it('rejects reserved tag', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'should fail',
        tags: ['transaction_entry'],
        objective_context: 'x',
      }),
      400,
      reservedTagError('transaction_entry'),
    )
  })

  it('rejects duplicate tags', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'dup',
        tags: ['study', 'study'],
        objective_context: 'x',
      }),
      400,
      'duplicate tag "study"',
    )
  })

  it('rejects todo reserved tag', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'should fail',
        tags: ['todo:in_progress'],
        objective_context: 'x',
      }),
      400,
      reservedTagError('todo:in_progress'),
    )
  })

  it('rejects non-string ai_analysis', async () => {
    await rejects(
      createText({
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'hello',
        tags: ['study'],
        objective_context: 'x',
        ai_analysis: 42,
      }),
      400,
      'invalid ai_analysis',
    )
  })

  it('rejects non-string raw_content', async () => {
    await rejects(
      createText({
        happened_at: '2026-07-30T08:00:00Z',
        raw_content: 123,
        tags: ['study'],
        objective_context: 'x',
      }),
      400,
      'missing required field: raw_content',
    )
  })
})
