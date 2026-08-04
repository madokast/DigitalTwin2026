import { describe, expect, it, vi } from 'vitest'
import {
  extractMultipartBoundary,
  formatDuplicateIdError,
  formatImportNotifyMessage,
  IMPORT_LIMITS_ERROR,
  importRecordsJsonl,
  isAcceptedImportFilePart,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_LINES,
  type ImportStore,
  type ImportTx,
} from './importapi'
import { serializeLine, type RecordJsonlRow } from './recordjsonl'

const ID1 = '01900000-0000-7000-8000-000000000001'
const ID2 = '01900000-0000-7000-8000-000000000002'

function sampleLine(id: string, tags = '["weight"]'): string {
  return JSON.stringify({
    id,
    happened_at: '2026-07-30T00:00:00.000Z',
    value_number: '1.5',
    value_text: null,
    tags,
    objective_context: 'scale',
    subjective_interpretation: null,
  })
}

function memoryStore(existing: Set<string> = new Set()): {
  store: ImportStore
  inserted: string[]
  updated: string[]
  began: { n: number }
} {
  const inserted: string[] = []
  const updated: string[] = []
  const began = { n: 0 }
  const store: ImportStore = {
    async begin(fn) {
      began.n += 1
      const tx: ImportTx = {
        async exists(id) {
          return existing.has(id)
        },
        async insert(row: RecordJsonlRow) {
          inserted.push(row.id)
          existing.add(row.id)
        },
        async update(row: RecordJsonlRow) {
          updated.push(row.id)
        },
      }
      return fn(tx)
    },
  }
  return { store, inserted, updated, began }
}

describe('importapi helpers', () => {
  it('formats notify and duplicate id', () => {
    expect(
      formatImportNotifyMessage({ inserted: 12, updated: 3, total: 15 }),
    ).toBe('Imported 15 records (inserted 12, updated 3)')
    expect(formatImportNotifyMessage({ inserted: 0, updated: 0, total: 0 })).toBe(
      'Imported 0 records (inserted 0, updated 0)',
    )
    expect(formatDuplicateIdError(ID1, 2)).toBe(
      `line 2: duplicate record id ${ID1}`,
    )
    expect(formatDuplicateIdError(ID1)).toBe(`duplicate record id ${ID1}`)
  })

  it('accepts allowed file part content types', () => {
    expect(isAcceptedImportFilePart('application/x-ndjson', 'x.bin')).toBe(true)
    expect(isAcceptedImportFilePart('application/jsonl; charset=utf-8', 'x')).toBe(
      true,
    )
    expect(
      isAcceptedImportFilePart('application/octet-stream', 'records.JSONL'),
    ).toBe(true)
    expect(
      isAcceptedImportFilePart('application/octet-stream', 'records.txt'),
    ).toBe(false)
    expect(isAcceptedImportFilePart('text/plain', 'records.jsonl')).toBe(false)
  })
})

describe('importRecordsJsonl', () => {
  it('returns zeros for empty file and still uses one transaction', async () => {
    const mem = memoryStore()
    const result = await importRecordsJsonl('', 0, mem.store)
    expect(result).toEqual({
      ok: true,
      counts: { inserted: 0, updated: 0, total: 0 },
    })
    expect(mem.began.n).toBe(1)
  })

  it('rejects oversize file bytes before parse', async () => {
    const mem = memoryStore()
    const result = await importRecordsJsonl('x', MAX_IMPORT_FILE_BYTES + 1, mem.store)
    expect(result).toEqual({
      ok: false,
      error: IMPORT_LIMITS_ERROR,
      status: 400,
    })
    expect(mem.began.n).toBe(0)
  })

  it('rejects more than 1000 non-empty lines', async () => {
    const mem = memoryStore()
    const lines: string[] = []
    for (let i = 0; i < MAX_IMPORT_LINES + 1; i++) {
      const id = `01900000-0000-7000-8000-${(i + 1).toString(16).padStart(12, '0')}`
      lines.push(sampleLine(id))
    }
    const text = lines.join('\n')
    const result = await importRecordsJsonl(text, text.length, mem.store)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe(IMPORT_LIMITS_ERROR)
      expect(result.status).toBe(400)
    }
  })

  it('rejects duplicate ids with uuid and line number', async () => {
    const mem = memoryStore()
    const text = `${sampleLine(ID1)}\n${sampleLine(ID1)}`
    const result = await importRecordsJsonl(text, text.length, mem.store)
    expect(result).toEqual({
      ok: false,
      error: `line 2: duplicate record id ${ID1}`,
      status: 400,
    })
  })

  it('rejects line-level parse errors with line prefix', async () => {
    const mem = memoryStore()
    const text = `${sampleLine(ID1)}\n{not-json}`
    const result = await importRecordsJsonl(text, text.length, mem.store)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('line 2: Invalid JSON line')
      expect(result.status).toBe(400)
    }
  })

  it('inserts new and updates existing; allows reserved tags', async () => {
    const mem = memoryStore(new Set([ID1]))
    const reserved = serializeLine({
      id: ID2,
      happenedAt: new Date('2026-07-30T00:00:00.000Z'),
      utcOffset: 'Z',
      valueNumber: '70',
      valueText: null,
      tags: ['body:weight'],
      objectiveContext: 'import reserved',
      subjectiveInterpretation: null,
    })
    const text = `${sampleLine(ID1)}\n${reserved}`
    const result = await importRecordsJsonl(text, text.length, mem.store)
    expect(result).toEqual({
      ok: true,
      counts: { inserted: 1, updated: 1, total: 2 },
    })
    expect(mem.updated).toEqual([ID1])
    expect(mem.inserted).toEqual([ID2])
  })

  it('rolls back domain errors via store.begin throwing path', async () => {
    const insert = vi.fn(async () => {})
    const store: ImportStore = {
      async begin(fn) {
        try {
          return await fn({
            exists: async () => false,
            insert,
            update: async () => {},
          })
        } catch (e) {
          // simulate rollback: nothing committed
          insert.mockClear()
          throw e
        }
      },
    }
    const text = `${sampleLine(ID1)}\n{bad}`
    const result = await importRecordsJsonl(text, text.length, store)
    expect(result.ok).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('extractMultipartBoundary', () => {
  it('returns unquoted boundary', () => {
    expect(extractMultipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
  })

  it('returns quoted boundary', () => {
    expect(
      extractMultipartBoundary('multipart/form-data; boundary="abc 123"'),
    ).toBe('abc 123')
  })

  it('returns null when boundary missing or empty', () => {
    expect(extractMultipartBoundary('multipart/form-data')).toBeNull()
    expect(extractMultipartBoundary('multipart/form-data; boundary=')).toBeNull()
    expect(extractMultipartBoundary('multipart/form-data; boundary=""')).toBeNull()
  })

  it('returns null on malformed content type (no semicolon params)', () => {
    expect(extractMultipartBoundary('multipart/form-data')).toBeNull()
    expect(extractMultipartBoundary('')).toBeNull()
  })
})
