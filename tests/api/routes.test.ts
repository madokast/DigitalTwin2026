import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type postgres from 'postgres'
import { POST as postNumbers } from '@/app/api/log/numbers/route'
import { POST as postBodyWeight } from '@/app/api/log/body/weight/route'
import { POST as postTodo } from '@/app/api/log/todo/route'
import { POST as postTodoTransition } from '@/app/api/log/todo/transition/route'
import { POST as postText } from '@/app/api/log/text/route'
import { POST as postReview } from '@/app/api/log/review/route'
import { POST as postTransactions } from '@/app/api/log/transactions/route'
import { GET as queryRecords } from '@/app/api/query/route'
import { GET as adminRecordsStats } from '@/app/api/admin/records/stats/route'
import { GET as getTime } from '@/app/api/time/route'
import { GET as queryTags } from '@/app/api/query/tags/route'
import { GET as exportRecords } from '@/app/api/export/records/route'
import { POST as importRecords } from '@/app/api/admin/import/records/route'
import { POST as normalizeTagsRoute } from '@/app/api/admin/tags/normalize/route'
import { POST as postTagsAdd } from '@/app/api/log/tags/add/route'
import { POST as postTagsRemove } from '@/app/api/log/tags/remove/route'
import { closeDb } from '@/db'
import {
  assertSafeTestDatabaseUrl,
  migrateTestDatabase,
  openTestAdminClient,
  SAFE_TEST_DATABASE_HINT,
} from '../helpers/db'
import { jsonGet, jsonPost, multipartPost } from '../helpers/http'
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
  /**
   * 与 Go 对齐：用 DELETE 清理，不用每测 TRUNCATE + 新建连接。
   * Node 有 summary/tags/pagination/export 全表断言，且 transaction 批量插入不回传 id，
   * 故用例后 `DELETE FROM records`（共享 admin 连接）；Go 冒烟测则按 marker 定向删。
   */
  let admin: postgres.Sql

  beforeAll(async () => {
    await migrateTestDatabase()
    admin = openTestAdminClient()
  }, 60_000)

  afterEach(async () => {
    await admin`DELETE FROM records`
  })

  afterAll(async () => {
    await admin.end({ timeout: 5 })
    await closeDb()
  }, 60_000)

  describe('POST /api/log/numbers', () => {
    const validEntry = (over = {}) => ({
      happened_at: '2026-07-30T08:00:00+08:00',
      entries: [{ numeric_value: '75.5', memo: 'morning weigh-in', ...over }],
    })

    it('returns 400 when happened_at is missing', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        entries: [{ numeric_value: '75.5', memo: 'morning weigh-in' }],
      }))
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      const body = await res.json()
      expect(body.detail).toContain('happened_at')
    })

    it('rejects suppress_notification as unknown top-level key', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        ...validEntry(),
        suppress_notification: true,
      } as Record<string, unknown>))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'Unknown JSON key: suppress_notification',
      )
    })

    it('returns 400 for invalid entry tags (non-ASCII / whitespace-padded)', async () => {
      for (const tags of [['体重'], [' weight'], ['weight '], [' weight ']]) {
        const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', validEntry({ tags })))
        expect(res.status, JSON.stringify(tags)).toBe(400)
        const body = await res.json()
        expect(body.detail, JSON.stringify(tags)).toContain('invalid tag')
      }
    })

    it('creates a batch and returns {success, inserted, atomic}', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [
          { numeric_value: '75.5', memo: 'morning weigh-in', ai_analysis: 'a bit heavy' },
          { numeric_value: '36.8', memo: 'axillary temperature' },
        ],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toEqual({
        success: true,
        inserted: 2,
        atomic: true,
      })
    })

    it('persists memo as objective_context with raw_content null', async () => {
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [
          {
            numeric_value: '75.5',
            memo: 'morning weigh-in',
            tags: ['persist_check'],
            ai_analysis: 'a bit heavy',
          },
        ],
      }))
      const q = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=persist_check',
      ))
      expect(q.status).toBe(200)
      const body = await q.json()
      expect(body.records).toHaveLength(1)
      const row = body.records[0]
      expect(row.objective_context).toBe('morning weigh-in')
      expect(row.raw_content).toBeNull()
      expect(row.numeric_value).toBe('75.5')
      expect(row.happened_at).toBe('2026-07-30T08:00:00.000+08:00')
      expect(row.ai_analysis).toBe('a bit heavy')
    })

    it('stores and reads back a small decimal like 0.0001', async () => {
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [
          { numeric_value: '0.0001', memo: 'tiny measurement', tags: ['persist_small'] },
        ],
      }))
      const q = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=persist_small',
      ))
      expect(q.status).toBe(200)
      const body = await q.json()
      expect(body.records).toHaveLength(1)
      expect(body.records[0].numeric_value).toBe('0.0001')
      expect(body.records[0].objective_context).toBe('tiny measurement')
    })

    it('rejects entry unknown key with index prefix', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', validEntry({ raw_content: 'x' })))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'entries[0]: Unknown JSON key: raw_content',
      )
    })

    it('returns 400 when happened_at lacks timezone', async () => {
      for (const happened of ['2026-07-30', '2026-07-30T08:00:00']) {
        const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
          happened_at: happened,
          entries: [{ numeric_value: '1', memo: 'x' }],
        }))
        expect(res.status).toBe(400)
        expect((await res.json()).detail).toBe(
          'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
        )
      }
    })

    it('rejects JSON number type for numeric_value with index prefix', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', validEntry({ numeric_value: 75.5 })))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'entries[0]: numeric_value must be a decimal string',
      )
    })

    it('rejects invalid decimal strings with index prefix', async () => {
      for (const bad of ['1e3', '1.', '+1']) {
        const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', validEntry({ numeric_value: bad })))
        expect(res.status).toBe(400)
        expect((await res.json()).detail).toBe(
          'entries[0]: invalid numeric_value',
        )
      }
    })

    it('rejects missing memo with index prefix', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [{ numeric_value: '1' }],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'entries[0]: missing required field: memo',
      )
    })

    it('rejects reserved entry tag with index prefix', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', validEntry({ tags: ['body:weight'] })))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        `entries[0]: ${reservedTagError('body:weight')}`,
      )
    })

    it('rejects empty entries', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'entries must be a non-empty array',
      )
    })

    it('rejects more than 100 entries with a top-level error', async () => {
      const many = Array.from({ length: 101 }, () => ({
        numeric_value: '1',
        memo: 'x',
      }))
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: many,
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'entries must contain at most 100 items',
      )
    })
  })

  describe('POST /api/log/text', () => {
    it('returns 400 when raw_content is missing', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        tags: ['study'],
        objective_context: 'afternoon',
      }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.detail).toContain('raw_content')
    })

    it('returns 400 when happened_at lacks timezone', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00',
        raw_content: 'hello',
        tags: ['study'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)',
      )
    })

    it('creates a text record', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        raw_content: 'studied 50 words',
        tags: ['study', 'vocabulary'],
        objective_context: 'afternoon study',
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.raw_content).toBe('studied 50 words')
      expect(body.record).not.toHaveProperty('numeric_value')
      expect(body.record.tags).toEqual(['study', 'vocabulary'])
    })

    it('rejects reserved tag', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'should fail',
        tags: ['transaction_entry'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(reservedTagError('transaction_entry'))
    })

    it('rejects review reserved tag (only /api/log/review can write it)', async () => {
      const res = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-08-01T12:30:00+08:00',
        raw_content: 'should fail',
        tags: ['review:weekly'],
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(reservedTagError('review:weekly'))
    })
  })

  describe('POST /api/log/review', () => {
    const validReview = {
      happened_at: '2026-08-09T19:00:00+08:00',
      cadence: 'weekly',
      raw_content: 'This week I slept better and finished the report.',
      objective_context: 'Weekly review covering 2026-08-03..2026-08-09',
      ai_analysis: 'Deeper work in the morning helped.',
      tags: ['work'],
    }

    it('creates a weekly review with auto-attached review tag', async () => {
      const res = await postReview(jsonPost('http://localhost/api/log/review', validReview))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.tags).toEqual(['review:weekly', 'work'])
      expect(body.record.raw_content).toBe(validReview.raw_content)
      expect(body.record.ai_analysis).toBe(validReview.ai_analysis)
      expect(body.record.happened_at).toBe('2026-08-09T19:00:00.000+08:00')
      expect(body.record).not.toHaveProperty('numeric_value')
    })

    it('auto-attaches review tag with empty client tags', async () => {
      const res = await postReview(
        jsonPost('http://localhost/api/log/review', {
          ...validReview,
          tags: [],
        }),
      )
      expect(res.status).toBe(201)
      expect((await res.json()).record.tags).toEqual(['review:weekly'])
    })

    it('accepts semiannually cadence', async () => {
      const res = await postReview(
        jsonPost('http://localhost/api/log/review', {
          ...validReview,
          cadence: 'semiannually',
        }),
      )
      expect(res.status).toBe(201)
      expect((await res.json()).record.tags).toEqual(['review:semiannually', 'work'])
    })

    it('rejects missing cadence', async () => {
      const { cadence: _omit, ...withoutCadence } = validReview
      void _omit
      const res = await postReview(
        jsonPost('http://localhost/api/log/review', withoutCadence),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('missing required field: cadence')
    })

    it('rejects invalid cadence with all allowed values', async () => {
      for (const cadence of ['WEEKLY', ' weekly', 'weekly2']) {
        const res = await postReview(
          jsonPost('http://localhost/api/log/review', {
            ...validReview,
            cadence,
          }),
        )
        expect(res.status, cadence).toBe(400)
        expect((await res.json()).detail).toBe(
          'invalid cadence: must be one of daily, weekly, monthly, quarterly, semiannually, yearly',
        )
      }
    })

    it('rejects client-provided review reserved tag', async () => {
      const res = await postReview(
        jsonPost('http://localhost/api/log/review', {
          ...validReview,
          tags: ['review:weekly'],
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(reservedTagError('review:weekly'))
    })

    it('rejects numeric_value as unknown key', async () => {
      const res = await postReview(
        jsonPost('http://localhost/api/log/review', {
          ...validReview,
          numeric_value: '1',
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('Unknown JSON key: numeric_value')
    })

    it('rejects blank raw_content', async () => {
      const res = await postReview(
        jsonPost('http://localhost/api/log/review', {
          ...validReview,
          raw_content: '   ',
        }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('raw_content must not be blank')
    })
  })

  describe('POST /api/log/transactions', () => {
    it('rejects empty entries', async () => {
      const res = await postTransactions(jsonPost('http://localhost/api/log/transactions', {
        happened_at: '2026-08-01T12:30:00+08:00',
        type: 'expense',
        entries: [],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('entries must be a non-empty array')
    })

    it('inserts multiple rows and returns inserted count only', async () => {
      const res = await postTransactions(jsonPost('http://localhost/api/log/transactions', {
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
      expect(body).toEqual({
        success: true,
        inserted: 2,
        type: 'expense',
        sum: '37.50',
        atomic: true,
      })
      expect(body.records).toBeUndefined()

      const q = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=transaction_entry:expense&page_size=10',
      ))
      expect(q.status).toBe(200)
      const qBody = await q.json()
      expect(qBody.count).toBe(2)
      expect(qBody.records.every((r: { tags: string[] }) =>
        r.tags.includes('transaction_entry:expense'),
      )).toBe(true)
    })

    it('rejects zero amount', async () => {
      const res = await postTransactions(jsonPost('http://localhost/api/log/transactions', {
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
      expect((await res.json()).detail).toBe(
        'entries[0]: invalid amount: non-zero decimal string, optional leading minus (no plus), at most 2 fractional digits, absolute value at most 999999999999.99, no spaces; e.g. 10, 10.5, 10.50, -1.5',
      )
    })

    it('rejects reserved tag on log/numbers', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-08-01T12:30:00+08:00',
        entries: [{ numeric_value: '1', memo: 'x', tags: ['transaction_entry'] }],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(`entries[0]: ${reservedTagError('transaction_entry')}`)
    })

    it('rejects reserved prefixed tag on log/numbers', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-08-01T12:30:00+08:00',
        entries: [{ numeric_value: '1', memo: 'x', tags: ['transaction_entry:income'] }],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(`entries[0]: ${reservedTagError('transaction_entry:income')}`)
    })

    it('rejects body:weight reserved tag on log/numbers', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-08-01T12:30:00+08:00',
        entries: [{ numeric_value: '1', memo: 'x', tags: ['body:weight'] }],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(`entries[0]: ${reservedTagError('body:weight')}`)
    })

    it('rejects todo reserved tag on log/numbers', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-08-01T12:30:00+08:00',
        entries: [{ numeric_value: '1', memo: 'x', tags: ['todo'] }],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(`entries[0]: ${reservedTagError('todo')}`)
    })

    it('rejects todo:in_progress reserved tag on log/numbers', async () => {
      const res = await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-08-01T12:30:00+08:00',
        entries: [{ numeric_value: '1', memo: 'x', tags: ['todo:in_progress'] }],
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(`entries[0]: ${reservedTagError('todo:in_progress')}`)
    })
  })

  describe('POST /api/log/body/weight', () => {
    it('creates a weight record with body:weight tag and normalized value', async () => {
      const res = await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        numeric_value: '75.5',
        objective_context: 'morning weigh-in',
        ai_analysis: 'a bit heavy',
        tags: ['morning'],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.numeric_value).toBe('75.50')
      expect(body.record.raw_content).toBeNull()
      expect(body.record.tags).toEqual(['body:weight', 'morning'])
      expect(body.record.objective_context).toBe('morning weigh-in')
    })

    it('rejects JSON number numeric_value', async () => {
      const res = await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        numeric_value: 75.5,
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('numeric_value must be a decimal string')
    })

    it('rejects out-of-range weight', async () => {
      const res = await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        numeric_value: '500.01',
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'invalid weight: positive decimal string from 1.00 to 500.00 inclusive, at most 2 fractional digits, no spaces; e.g. 75, 75.5, 75.50',
      )
    })
  })

  describe('POST /api/log/todo', () => {
    it('creates a to-do with todo:in_progress and deformed record keys', async () => {
      const res = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'Buy milk',
        objective_context: 'weekend grocery list',
        ai_analysis: 'need it for breakfast',
        tags: ['errand'],
      }))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.record.content).toBe('Buy milk')
      expect(body.record.created_at).toBe('2026-08-02T10:00:00.000+08:00')
      expect(body.record).not.toHaveProperty('numeric_value')
      expect(body.record.tags).toEqual(['todo:in_progress', 'errand'])
      expect(body.record.objective_context).toBe('weekend grocery list')
      expect(body.record).not.toHaveProperty('happened_at')
      expect(body.record).not.toHaveProperty('raw_content')
    })

    it('rejects missing content and reserved client tags', async () => {
      const missing = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        objective_context: 'x',
      }))
      expect(missing.status).toBe(400)
      expect((await missing.json()).detail).toBe('missing required field: content')

      const reserved = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'x',
        objective_context: 'x',
        tags: ['todo'],
      }))
      expect(reserved.status).toBe(400)
      expect((await reserved.json()).detail).toBe(reservedTagError('todo'))
    })

    it('rejects happened_at as unknown key', async () => {
      const res = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        happened_at: '2026-08-02T10:00:00+08:00',
        content: 'Buy milk',
        objective_context: 'x',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('Unknown JSON key: happened_at')
    })

    it('rejects utc_offset as unknown key', async () => {
      const res = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'Buy milk',
        objective_context: 'x',
        utc_offset: '+08:00',
      }))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe('Unknown JSON key: utc_offset')
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
      return body.record as { id: string; created_at: string; content: string; tags: string[] }
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
        tags: string[]
        created_at?: string
        content?: string
        happened_at?: string
        raw_content?: string
      }>
      expect(todoRows[0].tags).toEqual(['todo:completed', 'errand'])
      expect(todoRows[0].created_at).toBe(todo.created_at)
      expect(todoRows[0].content).toBe(todo.content)
      expect(todoRows[0]).not.toHaveProperty('happened_at')
      expect(todoRows[0]).not.toHaveProperty('raw_content')

      const qAudit = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=todo:transition',
      ))
      const audits = (await qAudit.json()).records as Array<{
        raw_content: string
        tags: string[]
        objective_context: string
        ai_analysis: string | null
        happened_at: string
        created_at?: string
        content?: string
      }>
      const audit = audits.find(
        (r) =>
          r.objective_context ===
          `Complete a to-do ${todo.id} created at ${todo.created_at}`,
      )
      expect(audit).toBeTruthy()
      expect(audit!.tags).toEqual(['todo:transition'])
      expect(audit!.happened_at).toBe('2026-08-02T12:00:00.000+08:00')
      // §3.1：审计行 raw_content = 待办正文逐字拷贝（非合成句）
      expect(audit!.raw_content).toBe(todo.content)
      expect(audit!.objective_context).toBe(
        `Complete a to-do ${todo.id} created at ${todo.created_at}`,
      )
      expect(audit!.ai_analysis).toBeNull()
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
      expect(missing.headers.get('content-type')).toContain('application/problem+json')
      expect((await missing.json()).detail).toBe('to-do not found')

      const text = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-08-02T10:00:00+08:00',
        raw_content: 'plain note',
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
      expect((await notTodo.json()).detail).toBe('record is not a to-do')

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
        objective_context: string
      }>
      const auditId = audits.find(
        (r) =>
          r.objective_context ===
          `Complete a to-do ${todo.id} created at ${todo.created_at}`,
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
      expect((await onAudit.json()).detail).toBe(
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
      expect((await already.json()).detail).toBe(
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
      expect((await res.json()).detail).toBe('Unknown JSON key: created_at')
    })
  })

  describe('GET /api/admin/records/stats', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns 0+0 on empty database', async () => {
      const res = await adminRecordsStats(jsonGet('http://localhost/api/admin/records/stats?tz=UTC'))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({
        success: true,
        total: 0,
        today: 0,
        tz: 'UTC',
      })
    })

    it('returns 400 when tz is missing or invalid', async () => {
      const missing = await adminRecordsStats(jsonGet('http://localhost/api/admin/records/stats'))
      expect(missing.status).toBe(400)

      const invalid = await adminRecordsStats(jsonGet('http://localhost/api/admin/records/stats?tz=Not%2FAZone'))
      expect(invalid.status).toBe(400)
      const body = await invalid.json()
      expect(body.detail).toBeTruthy()
    })

    it('counts today differently across time zones at day boundary', async () => {
      // Fixed "now": 2026-07-30 16:30 UTC = 2026-07-31 00:30 Asia/Shanghai
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T10:00:00.000Z',
        entries: [{ numeric_value: '1', memo: 'utc-only today', tags: ['a'] }],
      }))
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T18:00:00.000Z',
        entries: [{ numeric_value: '2', memo: 'both today', tags: ['b'] }],
      }))
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-31T02:00:00.000Z',
        entries: [{ numeric_value: '3', memo: 'shanghai-only today', tags: ['c'] }],
      }))

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-07-30T16:30:00.000Z'))

      // UTC 今日 = a+b；Asia/Shanghai 今日 = b+c（条数同为 2，集合不同）
      const utcRes = await adminRecordsStats(jsonGet('http://localhost/api/admin/records/stats?tz=UTC'))
      expect(utcRes.status).toBe(200)
      await expect(utcRes.json()).resolves.toEqual({
        success: true,
        total: 3,
        today: 2,
        tz: 'UTC',
      })

      const shRes = await adminRecordsStats(jsonGet(
        'http://localhost/api/admin/records/stats?tz=Asia%2FShanghai',
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

  describe('GET /api/time', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns now + tz for default / explicit / zero-offset zones', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-07-30T16:30:45.123Z'))

      const def = await getTime(jsonGet('http://localhost/api/time'))
      expect(def.status).toBe(200)
      await expect(def.json()).resolves.toEqual({
        success: true,
        now: '2026-07-30T16:30:45.123Z',
        tz: 'UTC',
      })

      const sh = await getTime(jsonGet(
        'http://localhost/api/time?tz=Asia%2FShanghai',
      ))
      expect(sh.status).toBe(200)
      await expect(sh.json()).resolves.toEqual({
        success: true,
        now: '2026-07-31T00:30:45.123+08:00',
        tz: 'Asia/Shanghai',
      })

      const ab = await getTime(jsonGet(
        'http://localhost/api/time?tz=Africa%2FAbidjan',
      ))
      expect(ab.status).toBe(200)
      await expect(ab.json()).resolves.toEqual({
        success: true,
        now: '2026-07-30T16:30:45.123Z',
        tz: 'Africa/Abidjan',
      })
    })

    it('returns 400 for empty or invalid tz', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-07-30T16:30:45.123Z'))

      for (const url of [
        'http://localhost/api/time?tz=',
        'http://localhost/api/time?tz=Not%2FAZone',
      ]) {
        const res = await getTime(jsonGet(url))
        expect(res.status, url).toBe(400)
        const body = await res.json()
        expect(body.detail, url).toBe(
          'query parameter tz must be a valid IANA time zone',
        )
      }
    })
  })

  describe('GET /api/query', () => {
    async function seed() {
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [{ numeric_value: '75.5', memo: 'fasting weight', tags: ['weight'] }],
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T15:00:00+08:00',
        raw_content: 'reviewed physics notes',
        tags: ['study', 'physics'],
        objective_context: 'focused session',
        ai_analysis: 'felt productive',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-31T12:00:00+08:00',
        raw_content: 'weekend walk',
        tags: ['walk'],
        objective_context: 'park',
      }))
    }

    it('deforms todo rows with created_at/content; keeps default keys for others', async () => {
      const created = await postTodo(jsonPost('http://localhost/api/log/todo', {
        created_at: '2026-08-02T10:00:00+08:00',
        content: 'query deform smoke',
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
      expect(row!.created_at).toBe('2026-08-02T10:00:00.000+08:00')
      expect(row!.content).toBe('query deform smoke')
      expect(row!).not.toHaveProperty('happened_at')
      expect(row!).not.toHaveProperty('raw_content')

      await seed()
      const plain = await queryRecords(jsonGet('http://localhost/api/query?tag=weight'))
      const weightRows = (await plain.json()).records as Array<Record<string, unknown>>
      expect(weightRows.length).toBeGreaterThan(0)
      expect(weightRows[0].happened_at).toBe('2026-07-30T08:00:00.000+08:00')
      expect(weightRows[0]).toHaveProperty('raw_content')
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
      expect(body.page_size).toBe(20)
      // happenedAt ASC, id ASC；weight 行为批量（raw_content null），text 行为 'reviewed physics notes'
      expect(body.records.map((r: { raw_content: string | null }) => r.raw_content)).toEqual([
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
      expect(body.records[0].raw_content).toBe('reviewed physics notes')
    })

    it('filters by review:* tag like any other tag', async () => {
      const created = await postReview(
        jsonPost('http://localhost/api/log/review', {
          happened_at: '2026-08-09T19:00:00+08:00',
          cadence: 'monthly',
          raw_content: 'July monthly review',
          objective_context: 'ctx',
        }),
      )
      expect(created.status).toBe(201)
      const review = (await created.json()).record as { id: string }

      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=review:monthly',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      const row = (body.records as Array<Record<string, unknown>>).find(
        (r) => r.id === review.id,
      )
      expect(row).toBeTruthy()
      expect(row!.tags).toEqual(['review:monthly'])
      expect(row!.raw_content).toBe('July monthly review')
    })

    it('matches a tag family with tag=X:* wildcard', async () => {
      await postReview(
        jsonPost('http://localhost/api/log/review', {
          happened_at: '2026-08-09T19:00:00+08:00',
          cadence: 'weekly',
          raw_content: 'weekly review',
          objective_context: 'weekly-ctx',
        }),
      )
      await postReview(
        jsonPost('http://localhost/api/log/review', {
          happened_at: '2026-08-10T19:00:00+08:00',
          cadence: 'monthly',
          raw_content: 'monthly review',
          objective_context: 'monthly-ctx',
        }),
      )

      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=review:*',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      const contents = (body.records as Array<Record<string, unknown>>).map(
        (r) => r.raw_content,
      )
      expect(contents).toEqual(
        expect.arrayContaining(['weekly review', 'monthly review']),
      )
    })

    it('family wildcard does not match non-colon prefix names (bodyguard)', async () => {
      // 语义边界：`tag=body:*` 只匹配 `body:` 前缀族，不匹配裸 `body`、`bodyguard`
      await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        numeric_value: '75.5',
        objective_context: 'weight-ctx',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-08-02T09:00:00+08:00',
        raw_content: 'guard duty',
        tags: ['bodyguard'],
        objective_context: 'guard-ctx',
      }))

      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=body:*',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      const ctxs = (body.records as Array<Record<string, unknown>>).map(
        (r) => r.objective_context,
      )
      expect(ctxs).toContain('weight-ctx')
      expect(ctxs).not.toContain('guard-ctx')
    })

    it('rejects invalid wildcard forms with a clear message', async () => {
      for (const url of [
        'http://localhost/api/query?tag=*',
        'http://localhost/api/query?tag=re*view',
        'http://localhost/api/query?tag=work*',
        'http://localhost/api/query?tag=re*vi*',
        'http://localhost/api/query?tag=review:*:x',
      ]) {
        const res = await queryRecords(jsonGet(url))
        expect(res.status, url).toBe(400)
        const body = await res.json()
        expect(body.detail, url).toMatch(/^invalid tag query/)
      }
    })

    it('returns a hint when querying a bare reserved prefix', async () => {
      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=review',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(0)
      expect(body.hint).toBe(
        'Use "tag=review:*" to match review records (the bare tag "review" is reserved and never stored)',
      )
    })

    it('does not hint body:weight (bare tag is stored)', async () => {
      await postBodyWeight(jsonPost('http://localhost/api/log/body/weight', {
        happened_at: '2026-08-02T08:00:00+08:00',
        numeric_value: '75.5',
        objective_context: 'x',
      }))
      const res = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=body:weight',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      expect(body.hint).toBeUndefined()
    })

    it('fuzzy-searches with q across text fields and tags', async () => {
      await seed()
      const res = await queryRecords(jsonGet('http://localhost/api/query?q=productive'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(1)
      expect(body.records[0].ai_analysis).toBe('felt productive')

      const byTag = await queryRecords(jsonGet('http://localhost/api/query?q=weight'))
      expect(byTag.status).toBe(200)
      const tagBody = await byTag.json()
      expect(tagBody.count).toBe(1)
      expect(tagBody.records[0].numeric_value).toBe('75.5')
    })

    it('defaults to page=1 page_size=20 and supports page 2', async () => {
      for (let i = 0; i < 25; i++) {
        await postText(jsonPost('http://localhost/api/log/text', {
          happened_at: `2026-07-30T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+08:00`,
          raw_content: `row-${i}`,
          tags: ['bulk'],
          objective_context: `ctx-${i}`,
        }))
      }

      const page1 = await queryRecords(jsonGet('http://localhost/api/query'))
      expect(page1.status).toBe(200)
      const body1 = await page1.json()
      expect(body1.count).toBe(25)
      expect(body1.page).toBe(1)
      expect(body1.page_size).toBe(20)
      expect(body1.records).toHaveLength(20)
      expect(body1.records[0].raw_content).toBe('row-0')
      expect(body1.records[19].raw_content).toBe('row-19')

      const page2 = await queryRecords(jsonGet('http://localhost/api/query?page=2'))
      const body2 = await page2.json()
      expect(body2.count).toBe(25)
      expect(body2.page).toBe(2)
      expect(body2.records).toHaveLength(5)
      expect(body2.records[0].raw_content).toBe('row-20')
      expect(body2.records[4].raw_content).toBe('row-24')
    }, 120_000)

    it('returns a single record by id and ignores pagination', async () => {
      await seed()
      const list = await queryRecords(jsonGet('http://localhost/api/query?q=productive'))
      const target = (await list.json()).records[0]

      const res = await queryRecords(jsonGet(
        `http://localhost/api/query?id=${target.id}&page=2&page_size=1`,
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

      const badSize = await queryRecords(jsonGet('http://localhost/api/query?page_size=101'))
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
      expect(dateOnlyBody.detail).toMatch(/timezone/i)

      const noOffset = await queryRecords(
        jsonGet('http://localhost/api/query?from=2026-07-30T00:00:00'),
      )
      expect(noOffset.status).toBe(400)
      const noOffsetBody = await noOffset.json()
      expect(noOffsetBody.detail).toMatch(/timezone/i)
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
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [{ numeric_value: '75.5', memo: 'fasting weight', tags: ['weight', 'morning'] }],
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T15:00:00+08:00',
        raw_content: 'reviewed physics notes',
        tags: ['study', 'physics'],
        objective_context: 'focused session',
      }))
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-31T08:00:00+08:00',
        entries: [{ numeric_value: '75.2', memo: 'follow-up weigh-in', tags: ['weight'] }],
      }))

      const res = await queryTags(jsonGet('http://localhost/api/query/tags'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      // 计数降序；同计数按 tag 名升序
      expect(body.tags).toEqual([
        { tag: 'weight', count: 2 },
        { tag: 'morning', count: 1 },
        { tag: 'physics', count: 1 },
        { tag: 'study', count: 1 },
      ])
    })

    it('filters by true prefix', async () => {
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        raw_content: 'arm day',
        tags: ['workout:arm'],
        objective_context: 'x',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T11:00:00+08:00',
        raw_content: 'leg day',
        tags: ['workout:leg'],
        objective_context: 'x',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T12:00:00+08:00',
        raw_content: 'plain note',
        tags: ['study'],
        objective_context: 'x',
      }))

      const res = await queryTags(jsonGet(
        'http://localhost/api/query/tags?prefix=workout',
      ))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.tags).toEqual([
        { tag: 'workout:arm', count: 1 },
        { tag: 'workout:leg', count: 1 },
      ])
    })

    it('returns empty array when there are no records', async () => {
      const res = await queryTags(jsonGet('http://localhost/api/query/tags'))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, tags: [] })
    })
  })

  describe('POST /api/admin/tags/normalize', () => {
    it('returns 400 when from/to missing or invalid', async () => {
      const missing = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        to: 'fitness',
      }))
      expect(missing.status).toBe(400)

      const notArray = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: 'exercise',
        to: 'fitness',
      }))
      expect(notArray.status).toBe(400)

      const invalid = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['exercise'],
        to: '体锻',
      }))
      expect(invalid.status).toBe(400)

      const toInFrom = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['exercise'],
        to: 'exercise',
      }))
      expect(toInFrom.status).toBe(400)

      const dup = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['exercise', 'exercise'],
        to: 'fitness',
      }))
      expect(dup.status).toBe(400)
    })

    it('normalizes multiple sources across records and reports updated count', async () => {
      await postNumbers(jsonPost('http://localhost/api/log/numbers', {
        happened_at: '2026-07-30T08:00:00+08:00',
        entries: [{ numeric_value: '1', memo: 'a', tags: ['exercise', 'morning'] }],
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T09:00:00+08:00',
        raw_content: 'gym',
        tags: ['exercise', 'workout'],
        objective_context: 'b',
      }))
      await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T10:00:00+08:00',
        raw_content: 'read',
        tags: ['study'],
        objective_context: 'c',
      }))

      // id-2 同时含 exercise + workout：一次多源变换 → 只算一次更新
      const res = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['exercise', 'workout'],
        to: 'fitness',
      }))
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ success: true, updated: 2 })

      const tagsRes = await queryTags(jsonGet('http://localhost/api/query/tags'))
      const body = await tagsRes.json()
      expect(body.tags).toEqual([
        { tag: 'fitness', count: 2 },
        { tag: 'morning', count: 1 },
        { tag: 'study', count: 1 },
      ])
      expect(body.tags.some((t: { tag: string }) => t.tag === 'exercise')).toBe(false)
      expect(body.tags.some((t: { tag: string }) => t.tag === 'workout')).toBe(false)
    })

    it('rejects reserved tag as from or to', async () => {
      const fromRes = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['transaction_entry'],
        to: 'legacy_tx',
      }))
      expect(fromRes.status).toBe(400)
      expect((await fromRes.json()).detail).toBe(reservedTagError('transaction_entry'))

      const toRes = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['food'],
        to: 'transaction_entry',
      }))
      expect(toRes.status).toBe(400)
      expect((await toRes.json()).detail).toBe(reservedTagError('transaction_entry'))

      const prefixed = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['transaction_entry:income'],
        to: 'legacy_tx',
      }))
      expect(prefixed.status).toBe(400)
      expect((await prefixed.json()).detail).toBe(
        reservedTagError('transaction_entry:income'),
      )

      const todoFrom = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['todo'],
        to: 'errand',
      }))
      expect(todoFrom.status).toBe(400)
      expect((await todoFrom.json()).detail).toBe(reservedTagError('todo'))

      const todoTo = await normalizeTagsRoute(jsonPost('http://localhost/api/admin/tags/normalize', {
        from: ['errand'],
        to: 'todo:in_progress',
      }))
      expect(todoTo.status).toBe(400)
      expect((await todoTo.json()).detail).toBe(reservedTagError('todo:in_progress'))
    })
  })

  describe('POST /api/log/tags/add + remove', () => {
    it('attaches, reports changed:false on duplicate, detaches; notifies only on change', async () => {
      const create = await postText(jsonPost('http://localhost/api/log/text', {
        happened_at: '2026-07-30T09:00:00+08:00',
        raw_content: 'gym',
        tags: ['exercise'],
        objective_context: 'session',
      }))
      expect(create.status).toBe(201)
      const id = (await create.json()).record.id as string

      const add = await postTagsAdd(jsonPost('http://localhost/api/log/tags/add', {
        id,
        tag: 'workout:arm',
      }))
      expect(add.status).toBe(200)
      const addBody = await add.json()
      expect(addBody).toEqual({
        success: true,
        id,
        changed: true,
        tags: { from: ['exercise'], to: ['exercise', 'workout:arm'] },
      })

      const dup = await postTagsAdd(jsonPost('http://localhost/api/log/tags/add', {
        id,
        tag: 'workout:arm',
      }))
      expect(dup.status).toBe(200)
      expect((await dup.json()).changed).toBe(false)

      const remove = await postTagsRemove(jsonPost('http://localhost/api/log/tags/remove', {
        id,
        tag: 'workout:arm',
      }))
      expect(remove.status).toBe(200)
      const removeBody = await remove.json()
      expect(removeBody).toEqual({
        success: true,
        id,
        changed: true,
        tags: { from: ['exercise', 'workout:arm'], to: ['exercise'] },
      })

      const absent = await postTagsRemove(jsonPost('http://localhost/api/log/tags/remove', {
        id,
        tag: 'workout:arm',
      }))
      expect(absent.status).toBe(200)
      expect((await absent.json()).changed).toBe(false)

      const rows = await admin`
        SELECT tags FROM records WHERE id = ${id}
      `
      expect(rows[0].tags).toBe(JSON.stringify(['exercise']))
    })

    it('rejects reserved tags on both add and remove; 404 for missing id', async () => {
      const addRes = await postTagsAdd(jsonPost('http://localhost/api/log/tags/add', {
        id: '01900000-0000-7000-8000-000000000001',
        tag: 'body:weight',
      }))
      expect(addRes.status).toBe(400)
      expect((await addRes.json()).detail).toBe(reservedTagError('body:weight'))

      const missing = await postTagsAdd(jsonPost('http://localhost/api/log/tags/add', {
        id: '01900000-0000-7000-8000-000000000099',
        tag: 'workout:arm',
      }))
      expect(missing.status).toBe(404)
      expect((await missing.json()).detail).toBe(
        'record 01900000-0000-7000-8000-000000000099 not found',
      )
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
      expect((await missing.json()).detail).toBe(
        'limit must be an integer between 1 and 1000',
      )

      const badFrom = await exportRecords(
        jsonGet(
          'http://localhost/api/export/records?from=not-a-uuid&limit=10',
        ),
      )
      expect(badFrom.status).toBe(400)
      expect((await badFrom.json()).detail).toBe('invalid record id')
    })

    it('returns 404 when from uuid does not exist', async () => {
      const res = await exportRecords(
        jsonGet(
          'http://localhost/api/export/records?from=01900000-0000-7000-8000-000000000000&limit=10',
        ),
      )
      expect(res.status).toBe(404)
      expect((await res.json()).detail).toBe('export from id not found')
    })

    it('exports by id ASC and supports overlapping cursor pages', async () => {
      const ids: string[] = []
      for (const n of ['1', '2', '3']) {
        const created = await postNumbers(
          jsonPost('http://localhost/api/log/numbers', {
            happened_at: '2026-07-30T08:00:00+08:00',
            entries: [{
              numeric_value: n,
              tags: ['export_test'],
              memo: `export-row-${n}`,
            }],
          }),
        )
        expect(created.status).toBe(201)
      }
      const seeded = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=export_test&page_size=10',
      ))
      const seededBody = await seeded.json()
      ids.push(...(seededBody.records as Array<{ id: string }>).map((r) => r.id))
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
      // Record snake_case only (no Todo deform keys)
      expect(overlap).toHaveProperty('happened_at')
      expect(overlap).not.toHaveProperty('created_at')
      expect(overlap).not.toHaveProperty('content')
    })

    it('exports happened_at with utc_offset (no utc_offset key)', async () => {
      const created = await postNumbers(
        jsonPost('http://localhost/api/log/numbers', {
          happened_at: '2026-07-30T08:00:00+08:00',
          entries: [{
            numeric_value: '1',
            tags: ['export_offset'],
            memo: 'phase4-export',
          }],
        }),
      )
      expect(created.status).toBe(201)
      const seeded = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=export_offset',
      ))
      const seededBody = await seeded.json()
      const rec = (seededBody.records as Array<{
        id: string
        happened_at: string
      }>)[0]
      expect(rec.happened_at).toBe('2026-07-30T08:00:00.000+08:00')

      const res = await exportRecords(
        jsonGet(
          `http://localhost/api/export/records?from=${rec.id}&limit=1`,
        ),
      )
      expect(res.status).toBe(200)
      const row = JSON.parse((await res.text()).trim()) as Record<
        string,
        unknown
      >
      expect(row.id).toBe(rec.id)
      expect(row.happened_at).toBe('2026-07-30T08:00:00.000+08:00')
      expect(row).not.toHaveProperty('utc_offset')
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
        atomic: true,
      })
    })

    it('rejects duplicate ids and line errors; rolls back', async () => {
      const id = '01900000-0000-7000-8000-0000000000aa'
      const line = JSON.stringify({
        id,
        happened_at: '2026-07-30T00:00:00.000Z',
        numeric_value: '1',
        raw_content: null,
        tags: '["weight"]',
        objective_context: 'import-dup',
        ai_analysis: null,
      })
      const dup = await importRecords(
        multipartPost(
          'http://localhost/api/admin/import/records',
          `${line}\n${line}`,
        ),
      )
      expect(dup.status).toBe(400)
      expect((await dup.json()).detail).toBe(
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
      expect((await bad.json()).detail).toBe('line 2: invalid JSON line')
      const listed2 = await queryRecords(
        jsonGet('http://localhost/api/query?page_size=10'),
      )
      expect((await listed2.json()).records).toHaveLength(0)
    })

    it('allows reserved tags on import', async () => {
      const id = '01900000-0000-7000-8000-0000000000bb'
      const line = JSON.stringify({
        id,
        happened_at: '2026-07-30T00:00:00.000Z',
        numeric_value: '70.5',
        raw_content: null,
        tags: '["body:weight"]',
        objective_context: 'import-reserved',
        ai_analysis: null,
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
        atomic: true,
      })
    })

    it('allows review:* on import (reserved-tag exception)', async () => {
      const id = '01900000-0000-7000-8000-0000000000bc'
      const line = JSON.stringify({
        id,
        happened_at: '2026-08-09T19:00:00+08:00',
        raw_content: 'Imported weekly review',
        tags: '["review:weekly"]',
        objective_context: 'import-review',
        ai_analysis: null,
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
        atomic: true,
      })
    })

    it('round-trips export → import', async () => {
      const created = await postNumbers(
        jsonPost('http://localhost/api/log/numbers', {
          happened_at: '2026-07-30T08:00:00+08:00',
          entries: [{
            numeric_value: '42',
            tags: ['roundtrip'],
            memo: 'export-import-rt',
          }],
        }),
      )
      expect(created.status).toBe(201)
      const seeded = await queryRecords(jsonGet(
        'http://localhost/api/query?tag=roundtrip',
      ))
      const seededBody = await seeded.json()
      const rec = (seededBody.records as Array<{
        id: string
        happened_at: string
        numeric_value: string
        tags: string[]
        objective_context: string
      }>)[0]
      expect(rec.happened_at).toBe('2026-07-30T08:00:00.000+08:00')

      const exported = await exportRecords(
        jsonGet(
          `http://localhost/api/export/records?from=${rec.id}&limit=1`,
        ),
      )
      expect(exported.status).toBe(200)
      const ndjson = await exported.text()
      expect(ndjson.trim()).not.toBe('')

      // 清空该行再导入（共享连接 DELETE，非整表 TRUNCATE 重建）
      await admin`DELETE FROM records WHERE id = ${rec.id}`

      const imported = await importRecords(
        multipartPost('http://localhost/api/admin/import/records', ndjson),
      )
      expect(imported.status).toBe(200)
      expect(await imported.json()).toEqual({
        success: true,
        inserted: 1,
        updated: 0,
        total: 1,
        atomic: true,
      })

      const listed = await queryRecords(
        jsonGet(`http://localhost/api/query?id=${rec.id}`),
      )
      const body = await listed.json()
      expect(body.records).toHaveLength(1)
      expect(body.records[0].id).toBe(rec.id)
      expect(body.records[0].numeric_value).toBe(rec.numeric_value)
      expect(body.records[0].objective_context).toBe(rec.objective_context)
      expect(body.records[0].tags).toEqual(rec.tags)
      expect(body.records[0].happened_at).toBe('2026-07-30T08:00:00.000+08:00')
      expect(body.records[0]).not.toHaveProperty('utc_offset')
    })

    it('rejects utc_offset key in import line', async () => {
      const id = '01900000-0000-7000-8000-0000000000cc'
      const line = JSON.stringify({
        id,
        happened_at: '2026-07-30T00:00:00.000Z',
        utc_offset: '+08:00',
        numeric_value: '1',
        raw_content: null,
        tags: '["weight"]',
        objective_context: 'import-utc-offset',
        ai_analysis: null,
      })
      const res = await importRecords(
        multipartPost('http://localhost/api/admin/import/records', line),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toBe(
        'line 1: Unknown JSON key: utc_offset',
      )
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
