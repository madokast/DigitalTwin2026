import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as postNumber } from '@/app/api/log/number/route'
import { POST as postBodyWeight } from '@/app/api/log/body/weight/route'
import { POST as postTodo } from '@/app/api/log/todo/route'
import { POST as postTodoTransition } from '@/app/api/log/todo/transition/route'
import { POST as postText } from '@/app/api/log/text/route'
import { POST as postTransaction } from '@/app/api/log/transaction/route'
import { GET as queryRecords } from '@/app/api/query/route'
import { GET as querySummary } from '@/app/api/query/summary/route'
import { GET as queryTags } from '@/app/api/query/tags/route'
import { GET as exportRecords } from '@/app/api/export/records/route'
import { POST as importRecords } from '@/app/api/admin/import/records/route'
import { POST as renameTags } from '@/app/api/admin/tags/rename/route'
import { PATCH as patchRecord } from '@/app/api/admin/records/[id]/route'
import { closeDb } from '@/db'
import {
  assertSafeTestDatabaseUrl,
  migrateTestDatabase,
  SAFE_TEST_DATABASE_HINT,
  truncateRecords,
} from '../helpers/db'
import { jsonGet, jsonPatch, jsonPost, multipartPost } from '../helpers/http'
import { reservedTagError } from '@/lib/tags'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** DATABASE_URL 缺失 → Skip；已设但 unsafe → throw（不 wipe）。不做 DROP。 */
function shouldRunApiIntegration(): boolean {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    console.warn(`Skipping API integration: DATABASE_URL is not set. ${SAFE_TEST_DATABASE_HINT}`)
    return false
  }
  assertSafeTestDatabaseUrl(url)
  return true
}

const runApiIntegration = shouldRunApiIntegration()

describe.skipIf(!runApiIntegration)('API integration', () => {
  beforeAll(async () => {
    await migrateTestDatabase()
  }, 60_000)

  beforeEach(async () => {
    await truncateRecords()
  })

  afterAll(async () => {
    await closeDb()
  }, 60_000)

  describe('POST /api/log/number', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        value_number: '75.5',
        tags: ['weight'],
        objective_context: 'morning weigh-in',
      }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('happened_at')
    })

    it('rejects suppress_notification as unknown key', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '75.5',
        tags: ['weight'],
        objective_context: 'morning weigh-in',
        suppress_notification: true,
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'Unknown JSON key: suppress_notification',
      )
    })

    it('returns 400 for invalid tags', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '75.5',
        tags: ['体重'],
        objective_context: 'morning weigh-in',
      }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid tag')
    })

    it('creates a number record', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '75.5',
        tags: ['weight'],
        objective_context: 'morning weigh-in',
        subjective_interpretation: 'a bit heavy',
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.valueNumber).toBe('75.5')
      expect(body.record.valueText).toBeNull()
      expect(body.record.tags).toBe(JSON.stringify(['weight']))
      expect(body.record.objectiveContext).toBe('morning weigh-in')
      expect(body.record.subjectiveInterpretation).toBe('a bit heavy')
    })

    it('returns 400 when happened_at lacks timezone', async () => {
      const bare = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30',
        value_number: '1',
        tags: ['weight'],
        objective_context: 'x',
      }))
      expect(bare.status).toBe(400)
      expect((await bare.json()).error).toBe(
        'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
      )

      const noOffset = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00',
        value_number: '1',
        tags: ['weight'],
        objective_context: 'x',
      }))
      expect(noOffset.status).toBe(400)
      expect((await noOffset.json()).error).toBe(
        'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
      )
    })

    it('accepts happened_at with Z and returns string valueNumber', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T00:00:00.000Z',
        value_number: '1',
        tags: ['weight'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.record.valueNumber).toBe('1')
      expect(body.record.happenedAt).toBe('2026-07-30T00:00:00.000Z')
    })

    it('rejects JSON number type for value_number', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: 75.5,
        tags: ['weight'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'value_number must be a decimal string',
      )
    })

    it('rejects invalid decimal strings', async () => {
      for (const bad of ['1e3', '1.', '+1']) {
        const res = await postNumber(jsonPost('http://localhost/api/log/number', {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: bad,
          tags: ['weight'],
          objective_context: 'x',
        }))
        expect(res.status).toBe(400)
        expect((await res.json()).error).toBe('Invalid value_number')
      }
    })

    it('preserves decimal literal including trailing zeros', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '1.0',
        tags: ['weight'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(201)
      expect((await res.json()).record.valueNumber).toBe('1.0')
    })
  })

  describe('POST /api/log/text', () => {
    it('returns 400 when value_text is missing', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        tags: ['study'],
        objective_context: 'afternoon',
      }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('value_text')
    })

    it('returns 400 when happened_at lacks timezone', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00',
        value_text: 'hello',
        tags: ['study'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
      )
    })

    it('creates a text record', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        value_text: 'studied 50 words',
        tags: ['study', 'vocabulary'],
        objective_context: 'afternoon study',
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.valueText).toBe('studied 50 words')
      expect(body.record.valueNumber).toBeNull()
      expect(body.record.tags).toBe(JSON.stringify(['study', 'vocabulary']))
    })

    it('rejects reserved tag', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-08-01T12:30:00+08:00',
        value_text: 'should fail',
        tags: ['transaction_entry'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('transaction_entry'))
    })
  })

  describe('POST /api/log/transaction', () => {
    it('rejects empty entries', async () => {
      const res = await postTransaction(jsonPost('http://localhost/api/log/transaction', {
        happened_at: '2026-08-01T12:30:00+08:00',
        type: 'expense',
        entries: [],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('entries must be a non-empty array')
    })

    it('inserts multiple rows and returns inserted count only', async () => {
      const res = await postTransaction(jsonPost('http://localhost/api/log/transaction', {
        happened_at: '2026-08-01T12:30:00+08:00',
        type: 'expense',
        entries: [
          {
            amount: '25.00',
            memo: 'beef noodle',
            category: 'food',
            subcategory: 'lunch',
          },
          {
            amount: '12.50',
            memo: 'tissues',
            category: 'food',
            subcategory: 'grocery',
          },
        ],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toEqual({ success: true, inserted: 2 })
      expect(body.records).toBeUndefined()

      const q = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=transaction_entry:expense&pageSize=10',
      ))
      expect(q.status).toBe(200)
      const qBody = await q.json()
      expect(qBody.count).toBe(2)
      expect(qBody.records.every((r: { tags: string }) =>
        r.tags.includes('transaction_entry:expense'),
      )).toBe(true)
    })

    it('rejects zero amount', async () => {
      const res = await postTransaction(jsonPost('http://localhost/api/log/transaction', {
        happened_at: '2026-08-01T12:30:00+08:00',
        type: 'income',
        entries: [
          {
            amount: '0.00',
            memo: 'noop',
            category: 'food',
            subcategory: 'other',
          },
        ],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'entries[0]: Invalid amount: non-zero decimal string, optional leading minus (no plus), at most 2 fractional digits, absolute value at most 999999999999.99, no spaces; e.g. 10, 10.5, 10.50, -1.5',
      )
    })

    it('rejects reserved tag on log/number', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-08-01T12:30:00+08:00',
        value_number: '1',
        tags: ['transaction_entry'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('transaction_entry'))
    })

    it('rejects reserved prefixed tag on log/number', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-08-01T12:30:00+08:00',
        value_number: '1',
        tags: ['transaction_entry:income'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('transaction_entry:income'))
    })

    it('rejects body:weight reserved tag on log/number', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-08-01T12:30:00+08:00',
        value_number: '1',
        tags: ['body:weight'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('body:weight'))
    })

    it('rejects todo reserved tag on log/number', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-08-01T12:30:00+08:00',
        value_number: '1',
        tags: ['todo'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('todo'))
    })

    it('rejects todo:in_progress reserved tag on log/number', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-08-01T12:30:00+08:00',
        value_number: '1',
        tags: ['todo:in_progress'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('todo:in_progress'))
    })
  })

  describe('POST /api/log/body/weight', () => {
    it('creates a weight record with body:weight tag and normalized value', async () => {
      const res = await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        value_number: '75.5',
        objective_context: 'morning weigh-in',
        subjective_interpretation: 'a bit heavy',
        tags: ['morning'],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.valueNumber).toBe('75.50')
      expect(body.record.valueText).toBeNull()
      expect(body.record.tags).toBe(JSON.stringify(['body:weight', 'morning']))
      expect(body.record.objectiveContext).toBe('morning weigh-in')
    })

    it('rejects JSON number value_number', async () => {
      const res = await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        value_number: 75.5,
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('value_number must be a decimal string')
    })

    it('rejects out-of-range weight', async () => {
      const res = await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        value_number: '500.01',
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        'Invalid weight: positive decimal string from 1.00 to 500.00 inclusive, at most 2 fractional digits, no spaces; e.g. 75, 75.5, 75.50',
      )
    })
  })

  describe('POST /api/log/todo', () => {
    it('creates a to-do with todo:in_progress and deformed record keys', async () => {
      const res = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'Buy milk',
        objective_context: 'weekend grocery list',
        subjective_interpretation: 'need it for breakfast',
        tags: ['errand'],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.content).toBe('Buy milk')
      expect(body.record.created_at).toBe('2026-08-02T02:00:00.000Z')
      expect(body.record.valueNumber).toBeNull()
      expect(body.record.tags).toBe(JSON.stringify(['todo:in_progress', 'errand']))
      expect(body.record.objectiveContext).toBe('weekend grocery list')
      expect(body.record).not.toHaveProperty('happenedAt')
      expect(body.record).not.toHaveProperty('valueText')
    })

    it('rejects missing content and reserved client tags', async () => {
      const missing = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        objective_context: 'x',
      }))
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toBe('Missing required field: content')

      const reserved = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'x',
        objective_context: 'x',
        tags: ['todo'],
      }))
      expect(reserved.status).toBe(400)
      expect((await reserved.json()).error).toBe(reservedTagError('todo'))
    })

    it('rejects happened_at as unknown key', async () => {
      const res = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        happened_at: '2026-08-02T10:00:00+08:00',
        content: 'Buy milk',
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Unknown JSON key: happened_at')
    })
  })

  describe('POST /api/log/todo/transition', () => {
    async function createTodoRow(content = 'Buy milk') {
      const res = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content,
        objective_context: 'weekend grocery list',
        tags: ['errand'],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      return body.record as { id: string; created_at: string; content: string; tags: string }
    }

    it('transitions in_progress → completed with 200 shape and audit row', async () => {
      const todo = await createTodoRow()
      const res = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: todo.id,
          target: 'completed',
          happened_at: '2026-08-02T12:00:00+08:00',
        },
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        success: true,
        id: todo.id,
        transition: { from: 'in_progress', to: 'completed' },
      })
      expect(body).not.toHaveProperty('record')
      expect(body).not.toHaveProperty('audit_record')

      const qTodo = await queryRecords(jsonGet(
        `http://localhost/api/query?id=${todo.id}`,
      ))
      expect(qTodo.status).toBe(200)
      const todoRows = (await qTodo.json()).records as Array<{
        tags: string
        created_at?: string
        content?: string
        happenedAt?: string
        valueText?: string
      }>
      expect(todoRows[0].tags).toBe(JSON.stringify(['todo:completed', 'errand']))
      expect(todoRows[0].created_at).toBe(todo.created_at)
      expect(todoRows[0].content).toBe(todo.content)
      expect(todoRows[0]).not.toHaveProperty('happenedAt')
      expect(todoRows[0]).not.toHaveProperty('valueText')

      const qAudit = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=todo:transition',
      ))
      const audits = (await qAudit.json()).records as Array<{
        valueText: string
        tags: string
        objectiveContext: string
        happenedAt: string
        created_at?: string
        content?: string
      }>
      const audit = audits.find((r) => r.objectiveContext === `The index of the to-do is ${todo.id}`)
      expect(audit).toBeTruthy()
      expect(audit!.tags).toBe(JSON.stringify(['todo:transition']))
      expect(audit!.happenedAt).toBe('2026-08-02T04:00:00.000Z')
      expect(audit!.valueText).toBe(
        `Complete a to-do created at ${todo.created_at}: ${todo.content}`,
      )
      expect(audit!).not.toHaveProperty('created_at')
      expect(audit!).not.toHaveProperty('content')
    })

    it('returns four distinct English errors', async () => {
      const todo = await createTodoRow('Distinct errors')

      const missing = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: '01900000-0000-7000-8000-000000000099',
          target: 'completed',
          happened_at: '2026-08-02T12:00:00+08:00',
        },
      ))
      expect(missing.status).toBe(404)
      expect((await missing.json()).error).toBe('to-do not found')

      const text = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-08-02T10:00:00+08:00',
        value_text: 'plain note',
        tags: ['note'],
        objective_context: 'x',
      }))
      expect(text.status).toBe(201)
      const textId = (await text.json()).record.id as string
      const notTodo = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: textId,
          target: 'completed',
          happened_at: '2026-08-02T12:00:00+08:00',
        },
      ))
      expect(notTodo.status).toBe(400)
      expect((await notTodo.json()).error).toBe('record is not a to-do')

      const done = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: todo.id,
          target: 'completed',
          happened_at: '2026-08-02T12:00:00+08:00',
        },
      ))
      expect(done.status).toBe(200)
      const auditQ = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=todo:transition',
      ))
      const audits = (await auditQ.json()).records as Array<{
        id: string
        objectiveContext: string
      }>
      const auditId = audits.find(
        (r) => r.objectiveContext === `The index of the to-do is ${todo.id}`,
      )!.id
      const onAudit = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: auditId,
          target: 'paused',
          happened_at: '2026-08-02T13:00:00+08:00',
        },
      ))
      expect(onAudit.status).toBe(400)
      expect((await onAudit.json()).error).toBe(
        'cannot transition a to-do audit record',
      )

      const already = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: todo.id,
          target: 'completed',
          happened_at: '2026-08-02T14:00:00+08:00',
        },
      ))
      expect(already.status).toBe(400)
      expect((await already.json()).error).toBe(
        'to-do is already in target state',
      )
    })

    it('rejects created_at as unknown key', async () => {
      const res = await postTodoTransition(jsonPost(
        'http://localhost/api/log/todo/transition',
        {
          id: '01900000-0000-7000-8000-000000000003',
          target: 'completed',
          happened_at: '2026-08-02T12:00:00+08:00',
          created_at: '2026-08-02T12:00:00+08:00',
        },
      ))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Unknown JSON key: created_at')
    })
  })

  describe('GET /api/query/summary', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns 0+0 on empty database', async () => {
      const res = await querySummary(jsonGet('http://localhost/api/query/summary?tz=UTC'))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({
        success: true,
        total: 0,
        today: 0,
        tz: 'UTC',
      })
    })

    it('returns 400 when tz is missing or invalid', async () => {
      const missing = await querySummary(jsonGet('http://localhost/api/query/summary'))
      expect(missing.status).toBe(400)

      const invalid = await querySummary(jsonGet('http://localhost/api/query/summary?tz=Not%2FAZone'))
      expect(invalid.status).toBe(400)
      const body = await invalid.json()
      expect(body.error).toBeTruthy()
    })

    it('counts today differently across time zones at day boundary', async () => {
      // Fixed "now": 2026-07-30 16:30 UTC = 2026-07-31 00:30 Asia/Shanghai
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T10:00:00.000Z',
        value_number: '1',
        tags: ['a'],
        objective_context: 'utc-only today',
      }))
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T18:00:00.000Z',
        value_number: '2',
        tags: ['b'],
        objective_context: 'both today',
      }))
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-31T02:00:00.000Z',
        value_number: '3',
        tags: ['c'],
        objective_context: 'shanghai-only today',
      }))

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-07-30T16:30:00.000Z'))

      // UTC 今日 = a+b；Asia/Shanghai 今日 = b+c（条数同为 2，集合不同）
      const utcRes = await querySummary(jsonGet('http://localhost/api/query/summary?tz=UTC'))
      expect(utcRes.status).toBe(200)
      await expect(utcRes.json()).resolves.toEqual({
        success: true,
        total: 3,
        today: 2,
        tz: 'UTC',
      })

      const shRes = await querySummary(jsonGet(
        'http://localhost/api/query/summary?tz=Asia%2FShanghai',
      ))
      expect(shRes.status).toBe(200)
      await expect(shRes.json()).resolves.toEqual({
        success: true,
        total: 3,
        today: 2,
        tz: 'Asia/Shanghai',
      })
    })
  })

  describe('GET /api/query', () => {
    async function seed() {
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '75.5',
        tags: ['weight', 'morning'],
        objective_context: 'fasting weight',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T15:00:00+08:00',
        value_text: 'reviewed physics notes',
        tags: ['study', 'physics'],
        objective_context: 'focused session',
        subjective_interpretation: 'felt productive',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-31T12:00:00+08:00',
        value_text: 'weekend walk',
        tags: ['walk'],
        objective_context: 'park',
      }))
    }

    it('deforms todo rows with created_at/content; keeps default keys for others', async () => {
      const created = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'Query deform smoke',
        objective_context: 'phase4',
        tags: ['errand'],
      }))
      expect(created.status).toBe(201)
      const todo = (await created.json()).record as {
        id: string
        created_at: string
        content: string
      }

      const byTag = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=todo:in_progress',
      ))
      expect(byTag.status).toBe(200)
      const todos = (await byTag.json()).records as Array<Record<string, unknown>>
      const row = todos.find((r) => r.id === todo.id)
      expect(row).toBeTruthy()
      expect(row!.created_at).toBe(todo.created_at)
      expect(row!.content).toBe('Query deform smoke')
      expect(row!).not.toHaveProperty('happenedAt')
      expect(row!).not.toHaveProperty('valueText')

      await seed()
      const plain = await queryRecords(jsonGet('http://localhost/api/query?tag=weight'))
      const weightRows = (await plain.json()).records as Array<Record<string, unknown>>
      expect(weightRows.length).toBeGreaterThan(0)
      expect(weightRows[0]).toHaveProperty('happenedAt')
      expect(weightRows[0]).toHaveProperty('valueText')
      expect(weightRows[0]).not.toHaveProperty('created_at')
      expect(weightRows[0]).not.toHaveProperty('content')
    })

    it('filters by half-open happened_at range [from, to)', async () => {
      await seed()
      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?from=2026-07-30T00:00:00%2B08:00&to=2026-07-31T00:00:00%2B08:00',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(2)
      expect(body.page).toBe(1)
      expect(body.pageSize).toBe(20)
      // happenedAt ASC, id ASC
      expect(body.records.map((r: { valueText: string | null }) => r.valueText)).toEqual([
        null,
        'reviewed physics notes',
      ])
    })

    it('filters by multiple tags with AND semantics', async () => {
      await seed()
      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=study&tag=physics',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      expect(body.records[0].valueText).toBe('reviewed physics notes')
    })

    it('fuzzy-searches with q across text fields and tags', async () => {
      await seed()
      const res = await queryRecords(jsonGet('http://localhost/api/query?q=productive'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      expect(body.records[0].subjectiveInterpretation).toBe('felt productive')

      const byTag = await queryRecords(jsonGet('http://localhost/api/query?q=weight'))
      expect(byTag.status).toBe(200)
      const tagBody = await byTag.json()
      expect(tagBody.count).toBe(1)
      expect(tagBody.records[0].valueNumber).toBe('75.5')
    })

    it('defaults to page=1 pageSize=20 and supports page 2', async () => {
      for (let i = 0; i < 25; i++) {
        await postText(jsonPost('http://localhost/api/log/text', {
          happened_at: `2026-07-30T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+08:00`,
          value_text: `row-${i}`,
          tags: ['bulk'],
          objective_context: `ctx-${i}`,
        }))
      }

      const page1 = await queryRecords(jsonGet('http://localhost/api/query'))
      expect(page1.status).toBe(200)
      const body1 = await page1.json()
      expect(body1.count).toBe(25)
      expect(body1.page).toBe(1)
      expect(body1.pageSize).toBe(20)
      expect(body1.records).toHaveLength(20)
      expect(body1.records[0].valueText).toBe('row-0')
      expect(body1.records[19].valueText).toBe('row-19')

      const page2 = await queryRecords(jsonGet('http://localhost/api/query?page=2'))
      const body2 = await page2.json()
      expect(body2.count).toBe(25)
      expect(body2.page).toBe(2)
      expect(body2.records).toHaveLength(5)
      expect(body2.records[0].valueText).toBe('row-20')
      expect(body2.records[4].valueText).toBe('row-24')
    }, 120_000)

    it('returns a single record by id and ignores pagination', async () => {
      await seed()
      const list = await queryRecords(jsonGet('http://localhost/api/query?q=productive'))
      const target = (await list.json()).records[0]

      const res = await queryRecords(jsonGet(
        `http://localhost/api/query?id=${target.id}&page=2&pageSize=1`,
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      expect(body.records).toHaveLength(1)
      expect(body.records[0].id).toBe(target.id)
    })

    it('returns 400 for invalid page, pageSize, from, or to', async () => {
      const badPage = await queryRecords(jsonGet('http://localhost/api/query?page=0'))
      expect(badPage.status).toBe(400)

      const badSize = await queryRecords(jsonGet('http://localhost/api/query?pageSize=101'))
      expect(badSize.status).toBe(400)

      const badFrom = await queryRecords(jsonGet('http://localhost/api/query?from=not-a-date'))
      expect(badFrom.status).toBe(400)
    })

    it('returns 400 when from/to lack timezone offset', async () => {
      const dateOnly = await queryRecords(
        jsonGet('http://localhost/api/query?from=2026-07-30'),
      )
      expect(dateOnly.status).toBe(400)
      const dateOnlyBody = await dateOnly.json()
      expect(dateOnlyBody.error).toMatch(/timezone/i)

      const noOffset = await queryRecords(
        jsonGet('http://localhost/api/query?from=2026-07-30T00:00:00'),
      )
      expect(noOffset.status).toBe(400)
      const noOffsetBody = await noOffset.json()
      expect(noOffsetBody.error).toMatch(/timezone/i)
    })

    it('accepts from/to with Z or +08:00', async () => {
      await seed()
      const withZ = await queryRecords(
        jsonGet(
          'http://localhost/api/query?from=2026-07-29T16:00:00Z&to=2026-07-30T16:00:00Z',
        ),
      )
      expect(withZ.status).toBe(200)
      expect((await withZ.json()).count).toBe(2)

      const withOffset = await queryRecords(
        jsonGet(
          'http://localhost/api/query?from=2026-07-30T00:00:00%2B08:00&to=2026-07-31T00:00:00%2B08:00',
        ),
      )
      expect(withOffset.status).toBe(200)
      expect((await withOffset.json()).count).toBe(2)
    })
  })

  describe('GET /api/query/tags', () => {
    it('returns success wrapper with lexicographically sorted tag counts', async () => {
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '75.5',
        tags: ['weight', 'morning'],
        objective_context: 'fasting weight',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T15:00:00+08:00',
        value_text: 'reviewed physics notes',
        tags: ['study', 'physics'],
        objective_context: 'focused session',
      }))
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-31T08:00:00+08:00',
        value_number: '75.2',
        tags: ['weight'],
        objective_context: 'follow-up weigh-in',
      }))

      const res = await queryTags(jsonGet('http://localhost/api/query/tags'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(Object.keys(body.tags)).toEqual(['morning', 'physics', 'study', 'weight'])
      expect(body.tags).toEqual({
        morning: 1,
        physics: 1,
        study: 1,
        weight: 2,
      })
    })

    it('returns empty tags object when there are no records', async () => {
      const res = await queryTags(jsonGet('http://localhost/api/query/tags'))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, tags: {} })
    })
  })

  describe('POST /api/admin/tags/rename', () => {
    it('returns 400 when from/to missing or invalid', async () => {
      const missing = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'exercise',
      }))
      expect(missing.status).toBe(400)

      const invalid = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'exercise',
        to: '体锻',
      }))
      expect(invalid.status).toBe(400)

      const same = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'exercise',
        to: 'exercise',
      }))
      expect(same.status).toBe(400)
    })

    it('renames tags across records and reports updated count', async () => {
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '1',
        tags: ['exercise', 'morning'],
        objective_context: 'a',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T09:00:00+08:00',
        value_text: 'gym',
        tags: ['exercise', 'workout'],
        objective_context: 'b',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        value_text: 'read',
        tags: ['study'],
        objective_context: 'c',
      }))

      const res = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'exercise',
        to: 'workout',
      }))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, updated: 2 })

      const tagsRes = await queryTags(jsonGet('http://localhost/api/query/tags'))
      const body = await tagsRes.json()
      expect(body.tags).toEqual({
        morning: 1,
        study: 1,
        workout: 2,
      })
      expect(body.tags.exercise).toBeUndefined()
    })

    it('rejects reserved tag as from or to', async () => {
      const fromRes = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'transaction_entry',
        to: 'legacy_tx',
      }))
      expect(fromRes.status).toBe(400)
      expect((await fromRes.json()).error).toBe(reservedTagError('transaction_entry'))

      const toRes = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'food',
        to: 'transaction_entry',
      }))
      expect(toRes.status).toBe(400)
      expect((await toRes.json()).error).toBe(reservedTagError('transaction_entry'))

      const prefixed = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'transaction_entry:income',
        to: 'legacy_tx',
      }))
      expect(prefixed.status).toBe(400)
      expect((await prefixed.json()).error).toBe(
        reservedTagError('transaction_entry:income'),
      )

      const todoFrom = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'todo',
        to: 'errand',
      }))
      expect(todoFrom.status).toBe(400)
      expect((await todoFrom.json()).error).toBe(reservedTagError('todo'))

      const todoTo = await renameTags(jsonPost('http://localhost/api/admin/tags/rename', {
        from: 'errand',
        to: 'todo:in_progress',
      }))
      expect(todoTo.status).toBe(400)
      expect((await todoTo.json()).error).toBe(reservedTagError('todo:in_progress'))
    })
  })

  describe('PATCH /api/admin/records/[id]', () => {
    async function createNumber() {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: '75.5',
        tags: ['weight'],
        objective_context: 'morning weigh-in',
        subjective_interpretation: 'ok',
      }))
      const body = await res.json()
      return body.record as { id: string }
    }

    it('updates editable fields', async () => {
      const record = await createNumber()
      const res = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${record.id}`, {
          happened_at: '2026-07-30T09:30:00+08:00',
          value_number: '76',
          value_text: null,
          tags: ['weight', 'source:device'],
          objective_context: 'updated context',
          subjective_interpretation: '',
        }),
        { params: Promise.resolve({ id: record.id }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.valueNumber).toBe('76')
      expect(body.record.tags).toBe(JSON.stringify(['weight', 'source:device']))
      expect(body.record.objectiveContext).toBe('updated context')
      expect(body.record.subjectiveInterpretation).toBeNull()
    })

    it('returns 400 when both values are null', async () => {
      const record = await createNumber()
      const res = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${record.id}`, {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: null,
          value_text: '',
          tags: ['weight'],
          objective_context: 'x',
          subjective_interpretation: null,
        }),
        { params: Promise.resolve({ id: record.id }) },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/both be null/)
    })

    it('returns 400 for invalid tags', async () => {
      const record = await createNumber()
      const res = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${record.id}`, {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: '1',
          value_text: null,
          tags: ['体重'],
          objective_context: 'x',
          subjective_interpretation: null,
        }),
        { params: Promise.resolve({ id: record.id }) },
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid tag')
    })

    it('rejects reserved tag in tags', async () => {
      const record = await createNumber()
      const res = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${record.id}`, {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: '1',
          value_text: null,
          tags: ['weight', 'transaction_entry'],
          objective_context: 'x',
          subjective_interpretation: null,
        }),
        { params: Promise.resolve({ id: record.id }) },
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(reservedTagError('transaction_entry'))
    })

    it('rejects reserved prefixed tag in tags', async () => {
      const record = await createNumber()
      const res = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${record.id}`, {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: '1',
          value_text: null,
          tags: ['weight', 'transaction_entry:expense'],
          objective_context: 'x',
          subjective_interpretation: null,
        }),
        { params: Promise.resolve({ id: record.id }) },
      )
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(
        reservedTagError('transaction_entry:expense'),
      )
    })

    it('returns 404 for unknown id', async () => {
      const id = '01900000-0000-7000-8000-000000000000'
      const res = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${id}`, {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: '1',
          value_text: null,
          tags: ['weight'],
          objective_context: 'x',
          subjective_interpretation: null,
        }),
        { params: Promise.resolve({ id }) },
      )
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/export/records', () => {
    it('returns empty NDJSON with headers when table is empty', async () => {
      const res = await exportRecords(
        jsonGet('http://localhost/api/export/records?limit=100'),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
      const disposition = res.headers.get('Content-Disposition') ?? ''
      expect(disposition).toMatch(
        /^attachment; filename="records-from-start-limit-100-\d{8}T\d{6}Z\.jsonl"$/,
      )
      expect(await res.text()).toBe('')
    })

    it('rejects missing/invalid limit and invalid from', async () => {
      const missing = await exportRecords(
        jsonGet('http://localhost/api/export/records'),
      )
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toBe(
        'limit must be an integer between 1 and 1000',
      )

      const badFrom = await exportRecords(
        jsonGet(
          'http://localhost/api/export/records?from=not-a-uuid&limit=10',
        ),
      )
      expect(badFrom.status).toBe(400)
      expect((await badFrom.json()).error).toBe('Invalid record id')
    })

    it('returns 404 when from uuid does not exist', async () => {
      const res = await exportRecords(
        jsonGet(
          'http://localhost/api/export/records?from=01900000-0000-7000-8000-000000000000&limit=10',
        ),
      )
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('export from id not found')
    })

    it('exports by id ASC and supports overlapping cursor pages', async () => {
      const ids: string[] = []
      for (const n of ['1', '2', '3']) {
        const created = await postNumber(
          jsonPost('http://localhost/api/log/number', {
            happened_at: '2026-07-30T08:00:00+08:00',
            value_number: n,
            tags: ['export_test'],
            objective_context: `export-row-${n}`,
          }),
        )
        expect(created.status).toBe(201)
        ids.push((await created.json()).record.id)
      }
      ids.sort()

      const page1 = await exportRecords(
        jsonGet('http://localhost/api/export/records?limit=2'),
      )
      expect(page1.status).toBe(200)
      const lines1 = (await page1.text()).trimEnd().split('\n')
      expect(lines1).toHaveLength(2)
      const row1 = JSON.parse(lines1[0]) as { id: string }
      const row2 = JSON.parse(lines1[1]) as { id: string }
      expect(row1.id).toBe(ids[0])
      expect(row2.id).toBe(ids[1])
      expect(row1.id < row2.id).toBe(true)

      const page2 = await exportRecords(
        jsonGet(
          `http://localhost/api/export/records?from=${row2.id}&limit=2`,
        ),
      )
      expect(page2.status).toBe(200)
      const lines2 = (await page2.text()).trimEnd().split('\n')
      expect(lines2).toHaveLength(2)
      const overlap = JSON.parse(lines2[0]) as { id: string }
      const last = JSON.parse(lines2[1]) as { id: string }
      expect(overlap.id).toBe(row2.id)
      expect(last.id).toBe(ids[2])
      // Record camelCase only (no Todo deform keys)
      expect(overlap).toHaveProperty('happenedAt')
      expect(overlap).not.toHaveProperty('created_at')
      expect(overlap).not.toHaveProperty('content')
    })
  })

  describe('POST /api/admin/import/records', () => {
    it('imports empty file as all zeros', async () => {
      const res = await importRecords(
        multipartPost('http://localhost/api/admin/import/records', ''),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        success: true,
        inserted: 0,
        updated: 0,
        total: 0,
      })
    })

    it('rejects duplicate ids and line errors; rolls back', async () => {
      const id = '01900000-0000-7000-8000-0000000000aa'
      const line = JSON.stringify({
        id,
        happenedAt: '2026-07-30T00:00:00.000Z',
        valueNumber: '1',
        valueText: null,
        tags: '["weight"]',
        objectiveContext: 'import-dup',
        subjectiveInterpretation: null,
      })
      const dup = await importRecords(
        multipartPost(
          'http://localhost/api/admin/import/records',
          `${line}\n${line}`,
        ),
      )
      expect(dup.status).toBe(400)
      expect((await dup.json()).error).toBe(
        `line 2: duplicate record id ${id}`,
      )
      const listed = await queryRecords(
        jsonGet('http://localhost/api/query?page_size=10'),
      )
      expect((await listed.json()).records).toHaveLength(0)

      const bad = await importRecords(
        multipartPost(
          'http://localhost/api/admin/import/records',
          `${line}\n{bad}`,
        ),
      )
      expect(bad.status).toBe(400)
      expect((await bad.json()).error).toBe('line 2: Invalid JSON line')
      const listed2 = await queryRecords(
        jsonGet('http://localhost/api/query?page_size=10'),
      )
      expect((await listed2.json()).records).toHaveLength(0)
    })

    it('allows reserved tags on import; PATCH still rejects them', async () => {
      const id = '01900000-0000-7000-8000-0000000000bb'
      const line = JSON.stringify({
        id,
        happenedAt: '2026-07-30T00:00:00.000Z',
        valueNumber: '70.5',
        valueText: null,
        tags: '["body:weight"]',
        objectiveContext: 'import-reserved',
        subjectiveInterpretation: null,
      })
      const res = await importRecords(
        multipartPost('http://localhost/api/admin/import/records', line),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        success: true,
        inserted: 1,
        updated: 0,
        total: 1,
      })

      const patch = await patchRecord(
        jsonPatch(`http://localhost/api/admin/records/${id}`, {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: '71',
          tags: ['body:weight'],
          objective_context: 'patch-reserved',
        }),
        { params: Promise.resolve({ id }) },
      )
      expect(patch.status).toBe(400)
      expect((await patch.json()).error).toBe(reservedTagError('body:weight'))
    })

    it('round-trips export → import', async () => {
      const created = await postNumber(
        jsonPost('http://localhost/api/log/number', {
          happened_at: '2026-07-30T08:00:00+08:00',
          value_number: '42',
          tags: ['roundtrip'],
          objective_context: 'export-import-rt',
        }),
      )
      expect(created.status).toBe(201)
      const rec = (await created.json()).record as {
        id: string
        happenedAt: string
        valueNumber: string
        tags: string
        objectiveContext: string
      }

      const exported = await exportRecords(
        jsonGet(
          `http://localhost/api/export/records?from=${rec.id}&limit=1`,
        ),
      )
      expect(exported.status).toBe(200)
      const ndjson = await exported.text()
      expect(ndjson.trim()).not.toBe('')

      await truncateRecords()

      const imported = await importRecords(
        multipartPost('http://localhost/api/admin/import/records', ndjson),
      )
      expect(imported.status).toBe(200)
      expect(await imported.json()).toEqual({
        success: true,
        inserted: 1,
        updated: 0,
        total: 1,
      })

      const listed = await queryRecords(
        jsonGet(`http://localhost/api/query?id=${rec.id}`),
      )
      const body = await listed.json()
      expect(body.records).toHaveLength(1)
      expect(body.records[0].id).toBe(rec.id)
      expect(body.records[0].valueNumber).toBe(rec.valueNumber)
      expect(body.records[0].objectiveContext).toBe(rec.objectiveContext)
      expect(body.records[0].tags).toBe(rec.tags)
    })

    it('route source bypasses readJsonBody', () => {
      const src = readFileSync(
        path.resolve(
          process.cwd(),
          'src/app/api/admin/import/records/route.ts',
        ),
        'utf8',
      )
      expect(src).not.toMatch(/from ['"]@\/lib\/httpjson['"]/)
      expect(src).not.toMatch(/\breadJsonBody\s*\(/)
      expect(src).toMatch(/formData/)
    })
  })
})
