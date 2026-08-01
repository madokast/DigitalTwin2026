import { describe, expect, it, vi } from 'vitest'
import {
  RECORD_NOT_FOUND,
  formatHappenedAt,
  fromDB,
  tagsJSON,
  update,
  type UpdateDb,
} from '@/lib/record'
import type { NormalizedRecordDraft } from '@/lib/draft'

describe('formatHappenedAt', () => {
  it('formats Date as UTC ISO with Z (matches Go FormatHappenedAt)', () => {
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
  it('maps happenedAt to string and preserves other fields', () => {
    const rec = fromDB({
      id: '01900000-0000-7000-8000-000000000001',
      happenedAt: new Date('2026-07-30T10:00:00.000Z'),
      valueNumber: '75.5',
      valueText: null,
      tags: '["weight"]',
      objectiveContext: 'morning',
      subjectiveInterpretation: null,
    })
    expect(rec.happenedAt).toBe('2026-07-30T10:00:00.000Z')
    expect(typeof rec.happenedAt).toBe('string')
    expect(rec.valueNumber).toBe('75.5')
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
        happenedAt: '2026-07-30T10:00:00.000Z',
        valueNumber: '80.0',
        valueText: null,
        tags: '["weight"]',
        objectiveContext: 'morning',
        subjectiveInterpretation: null,
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
    const result = await update('missing-id', draft, { updateReturning })
    expect(result).toEqual({ error: RECORD_NOT_FOUND, status: 404 })
    expect(updateReturning).toHaveBeenCalledOnce()
  })
})
