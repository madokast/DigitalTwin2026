import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as postNumber } from '@/app/api/log/number/route'
import { POST as postBodyWeight } from '@/app/api/log/body/weight/route'
import { POST as postText } from '@/app/api/log/text/route'
import { POST as postTransaction } from '@/app/api/log/transaction/route'
import { GET as queryRecords } from '@/app/api/query/route'
import { GET as querySummary } from '@/app/api/query/summary/route'
import { GET as queryTags } from '@/app/api/query/tags/route'
import { POST as renameTags } from '@/app/api/admin/tags/rename/route'
import { PATCH as patchRecord } from '@/app/api/admin/records/[id]/route'
import { closeDb } from '@/db'
import { migrateTestDatabase, truncateRecords } from '../helpers/db'
import { jsonGet, jsonPatch, jsonPost } from '../helpers/http'
import { reservedTagError } from '@/lib/tags'

/** 只认 TEST_DATABASE_URL（不做 DROP）；缺失则 Skip，避免误用生产 DATABASE_URL */
const hasTestDatabaseUrl = Boolean(process.env.TEST_DATABASE_URL?.trim())

describe.skipIf(!hasTestDatabaseUrl)('API integration', () => {
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
})
