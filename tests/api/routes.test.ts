import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as postNumber } from '@/app/api/log/number/route'
import { POST as postText } from '@/app/api/log/text/route'
import { GET as queryRecords } from '@/app/api/query/route'
import { GET as queryTags } from '@/app/api/query/tags/route'
import { POST as renameTags } from '@/app/api/admin/tags/rename/route'
import { closeDb } from '@/db'
import { dropTestSchema, migrateTestDatabase, truncateRecords } from '../helpers/db'
import { jsonGet, jsonPost } from '../helpers/http'

describe('API integration', () => {
  beforeAll(async () => {
    await migrateTestDatabase()
  }, 60_000)

  beforeEach(async () => {
    await truncateRecords()
  })

  afterAll(async () => {
    await dropTestSchema()
    await closeDb()
  }, 60_000)

  describe('POST /api/log/number', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await postNumber(jsonPost('http://localhost/api/log/number', {
        value_number: 75.5,
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
        value_number: 75.5,
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
        value_number: 75.5,
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
  })

  describe('GET /api/query', () => {
    async function seed() {
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: 75.5,
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
  })

  describe('GET /api/query/tags', () => {
    it('returns success wrapper with lexicographically sorted tag counts', async () => {
      await postNumber(jsonPost('http://localhost/api/log/number', {
        happened_at: '2026-07-30T08:00:00+08:00',
        value_number: 75.5,
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
        value_number: 75.2,
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
        value_number: 1,
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
  })
})
