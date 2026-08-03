import { describe, expect, it, vi } from 'vitest'
import {
  INVALID_RECORD_ID,
  RECORD_NOT_FOUND,
  formatHappenedAt,
  fromDB,
  isValidRecordId,
  tagsJSON,
  update,
  type UpdateDb,
} from '@/lib/record'
import type { NormalizedRecordDraft } from '@/lib/draft'

describe('isValidRecordId', () => {
  it('accepts UUIDv7 / nil UUID like npm uuid.validate', () => {
    expect(isValidRecordId('01900000-0000-7000-8000-000000000001')).toBe(true)
    expect(isValidRecordId('00000000-0000-0000-0000-000000000000')).toBe(true)
  })

  it('rejects illegal version/variant that google/uuid.Parse would accept', () => {
    expect(isValidRecordId('a0eebc99-9c0b-4ef8-7000-6bb9bd380a11')).toBe(false)
    expect(isValidRecordId('01234567-89ab-cdef-0123-456789abcdef')).toBe(false)
  })
})

describe('formatHappenedAt (UTC Z fallback only)', () => {
  it('formats Date as UTC ISO with Z (corrupt-offset fallback)', () => {
    expect(formatHappenedAt(new Date('2026-07-30T08:00:00+08:00'))).toBe(
      '2026-07-30T00:00:00.000Z',
    )
  })

  it('normalizes offset strings to UTC Z', () => {
    expect(formatHappenedAt('2026-07-30T08:00:00+08:00')).toBe(
      '2026-07-30T00:00:00.000Z',
    )
  })
})

describe('fromDB', () => {
  it('maps DB row to snake_case API Record with utc_offset formatting', () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T10:00:00.000Z'),
      utcOffset: 'Z',
      valueNumber: '75.5',
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'morning',
      subjectiveInterpretation: null,
    })
    expect(rec.happened_at).toBe('2026-07-30T10:00:00.000Z')
    expect(typeof rec.happened_at).toBe('string')
    expect(rec.value_number).toBe('75.5')
  })

  it('formats happened_at with stored +08:00 offset', () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000002',
      happenedAt: new Date('2026-07-30T00:00:00.000Z'),
      utcOffset: '+08:00',
      valueNumber: '1',
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'x',
      subjectiveInterpretation: null,
    })
    expect(rec.happened_at).toBe('2026-07-30T08:00:00.000+08:00')
  })
})

describe('tagsJSON', () => {
  it('marshals tags array to JSON string', () => {
    expect(tagsJSON(['weight', 'morning'])).toBe('["weight","morning"]')
  })
})

describe('update (404 contract)', () => {
  it('RECORD_NOT_FOUND stays byte-identical to Go ErrNotFound', () => {
    expect(RECORD_NOT_FOUND).toBe('Record not found')
  })
})

/** update 写库路径：注入 UpdateDb，不依赖真实 Neon */
describe('update (injected store)', () => {
  const draft: NormalizedRecordDraft = {
    happenedAt: new Date('2026-07-30T10:00:00.000Z'),
    utcOffset: 'Z',
    valueNumber: '80.0',
    valueText: null,
    tags: ['weight'],
    objectiveContext: 'morning',
    subjectiveInterpretation: null,
  }

  it('maps returning row to Record with status 200', async () => {
    const updateReturning = vi.fn(async () => ({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T10:00:00.000Z'),
      utcOffset: 'Z',
      valueNumber: '80.0',
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'morning',
      subjectiveInterpretation: null,
    }))
    const store: UpdateDb = { updateReturning }

    const result = await update(
      '01900000-0000-7000-8000-000000000001',
      draft,
      store,
    )
    expect(result).toEqual({
      status: 200,
      record: {
        id: '01900000-0000-7000-8000-000000000001',
        happened_at: '2026-07-30T10:00:00.000Z',
        value_number: '80.0',
        value_text: null,
        tags: '["weight"]',
        objective_context: 'morning',
        subjective_interpretation: null,
      },
    })
    expect(updateReturning).toHaveBeenCalledWith(
      '01900000-0000-7000-8000-000000000001',
      {
        happenedAt: draft.happenedAt,
        valueNumber: '80.0',
        valueText: null,
        tags: '["weight"]',
        objectiveContext: 'morning',
        subjectiveInterpretation: null,
      },
    )
  })

  it('returns RECORD_NOT_FOUND 404 when no row', async () => {
    const updateReturning = vi.fn(async () => undefined)
    const result = await update(
      '01900000-0000-7000-8000-000000000099',
      draft,
      { updateReturning },
    )
    expect(result).toEqual({ error: RECORD_NOT_FOUND, status: 404 })
    expect(updateReturning).toHaveBeenCalledOnce()
  })

  it('rejects non-UUID id with 400 before DB', async () => {
    const updateReturning = vi.fn().mockResolvedValue(undefined)
    const result = await update('not-a-uuid', draft, { updateReturning })
    expect(result).toEqual({ error: INVALID_RECORD_ID, status: 400 })
    expect(updateReturning).not.toHaveBeenCalled()
  })
})
