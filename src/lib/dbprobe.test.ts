import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DATABASE_UNREACHABLE,
  DATABASE_URL_NOT_SET,
  probeDatabase,
  sanitizeProbeError,
} from './dbprobe'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sanitizeProbeError', () => {
  it('never echoes connection strings', () => {
    expect(
      sanitizeProbeError(
        new Error('connect to postgresql://user:secret@host/db failed'),
      ),
    ).toBe(DATABASE_UNREACHABLE)
  })
})

describe('probeDatabase', () => {
  it('returns 503 when DATABASE_URL is missing', async () => {
    const result = await probeDatabase(() => undefined)
    if (!('error' in result)) throw new Error('expected failure')
    expect(result.error.status).toBe(503)
    expect(result.error.message).toBe(DATABASE_URL_NOT_SET)
  })

  it('returns timings and ok when reachable with records table', async () => {
    const release = vi.fn()
    const reserved = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ ok: 1 }])
        .mockResolvedValueOnce([{ ok: 1 }])
        .mockResolvedValueOnce([{ t: 'records' }]),
      { release },
    )
    const end = vi.fn().mockResolvedValue(undefined)
    const reserve = vi.fn().mockResolvedValue(reserved)
    const createSql = vi.fn().mockReturnValue({ reserve, end })

    const result = await probeDatabase(() => 'postgresql://u:p@test-host/db', createSql as never)

    expect(result).toMatchObject({
      ok: true,
      database_reachable: true,
      records_table_exists: true,
    })
    if ('error' in result) throw new Error('expected success')
    expect(result.connect_ms).toBeGreaterThanOrEqual(0)
    expect(result.select1_first_ms).toBeGreaterThanOrEqual(0)
    expect(result.select1_second_ms).toBeGreaterThanOrEqual(0)
    expect(release).toHaveBeenCalled()
    expect(end).toHaveBeenCalled()
  })

  it('returns ok:false when reachable but records missing', async () => {
    const release = vi.fn()
    const reserved = Object.assign(
      vi
        .fn()
        .mockResolvedValueOnce([{ ok: 1 }])
        .mockResolvedValueOnce([{ ok: 1 }])
        .mockResolvedValueOnce([{ t: null }]),
      { release },
    )
    const createSql = vi.fn().mockReturnValue({
      reserve: vi.fn().mockResolvedValue(reserved),
      end: vi.fn().mockResolvedValue(undefined),
    })

    const result = await probeDatabase(() => 'postgresql://u:p@test-host/db', createSql as never)
    expect(result).toMatchObject({
      ok: false,
      database_reachable: true,
      records_table_exists: false,
    })
  })

  it('returns 503 when connect fails', async () => {
    const createSql = vi.fn().mockReturnValue({
      reserve: vi.fn().mockRejectedValue(new Error('postgresql://secret boom')),
      end: vi.fn().mockResolvedValue(undefined),
    })
    const result = await probeDatabase(() => 'postgresql://u:p@test-host/db', createSql as never)
    if (!('error' in result)) throw new Error('expected failure')
    expect(result.error.status).toBe(503)
    expect(result.error.message).toBe(DATABASE_UNREACHABLE)
  })
})
