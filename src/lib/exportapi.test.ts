import { describe, expect, it } from 'vitest'
import {
  buildExportNdjson,
  EXPORT_FROM_NOT_FOUND,
  EXPORT_LIMIT_ERROR,
  exportContentDisposition,
  exportFilename,
  formatExportNotifyMessage,
  formatExportTimestamp,
  parseExportRecordsParams,
} from '@/lib/exportapi'
import { INVALID_RECORD_ID, type Record } from '@/lib/record'
import { serializeRecord } from '@/lib/recordjsonl'

const sample: Record = {
  id: '01900000-0000-7000-8000-000000000001',
  happened_at: '2026-07-30T00:00:00.000Z',
  numeric_value: '1.5',
  raw_content: null,
  tags: ['weight'],
  objective_context: 'scale',
  subjective_interpretation: null,
}

describe('parseExportRecordsParams', () => {
  it('requires limit in 1..1000', () => {
    expect(parseExportRecordsParams(new URLSearchParams())).toEqual({
      error: EXPORT_LIMIT_ERROR,
    })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=')),
    ).toEqual({ error: EXPORT_LIMIT_ERROR })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=0')),
    ).toEqual({ error: EXPORT_LIMIT_ERROR })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=1001')),
    ).toEqual({ error: EXPORT_LIMIT_ERROR })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=abc')),
    ).toEqual({ error: EXPORT_LIMIT_ERROR })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=1.5')),
    ).toEqual({ error: EXPORT_LIMIT_ERROR })
  })

  it('accepts limit without from', () => {
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=100')),
    ).toEqual({ from: null, limit: 100 })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=1')),
    ).toEqual({ from: null, limit: 1 })
    expect(
      parseExportRecordsParams(new URLSearchParams('limit=1000')),
    ).toEqual({ from: null, limit: 1000 })
  })

  it('rejects invalid from UUID with Invalid record id', () => {
    expect(
      parseExportRecordsParams(
        new URLSearchParams('from=not-a-uuid&limit=10'),
      ),
    ).toEqual({ error: INVALID_RECORD_ID })
    expect(
      parseExportRecordsParams(
        new URLSearchParams(
          'from=01234567-89ab-cdef-0123-456789abcdef&limit=10',
        ),
      ),
    ).toEqual({ error: INVALID_RECORD_ID })
  })

  it('accepts valid from + limit', () => {
    expect(
      parseExportRecordsParams(
        new URLSearchParams(
          'from=01900000-0000-7000-8000-000000000001&limit=50',
        ),
      ),
    ).toEqual({
      from: '01900000-0000-7000-8000-000000000001',
      limit: 50,
    })
  })
})

describe('buildExportNdjson / filename / notify', () => {
  it('builds empty body for 0 rows', () => {
    expect(buildExportNdjson([])).toBe('')
  })

  it('builds NDJSON with trailing newline per row', () => {
    const second: Record = {
      ...sample,
      id: '01900000-0000-7000-8000-000000000002',
    }
    const body = buildExportNdjson([sample, second])
    expect(body).toBe(
      `${serializeRecord(sample)}\n${serializeRecord(second)}\n`,
    )
  })

  it('formats filename and disposition', () => {
    const now = new Date('2026-08-03T08:41:00.123Z')
    expect(formatExportTimestamp(now)).toBe('20260803T084100Z')
    expect(exportFilename(null, 100, now)).toBe(
      'records-from-start-limit-100-20260803T084100Z.jsonl',
    )
    expect(
      exportFilename('01900000-0000-7000-8000-000000000001', 50, now),
    ).toBe(
      'records-from-01900000-0000-7000-8000-000000000001-limit-50-20260803T084100Z.jsonl',
    )
    expect(exportContentDisposition(null, 10, now)).toBe(
      'attachment; filename="records-from-start-limit-10-20260803T084100Z.jsonl"',
    )
  })

  it('formats notify message', () => {
    expect(formatExportNotifyMessage(0, null, 100)).toBe(
      'Exported 0 records (from start, limit 100)',
    )
    expect(
      formatExportNotifyMessage(
        3,
        '01900000-0000-7000-8000-000000000001',
        50,
      ),
    ).toBe(
      'Exported 3 records (from 01900000-0000-7000-8000-000000000001, limit 50)',
    )
  })

  it('exports from-not-found constant', () => {
    expect(EXPORT_FROM_NOT_FOUND).toBe('export from id not found')
  })
})
