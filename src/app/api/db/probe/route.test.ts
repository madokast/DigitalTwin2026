import { afterEach, describe, expect, it, vi } from 'vitest'
import { MyError } from '@/lib/myerr'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('POST /api/db/probe', () => {
  it('returns 503 when DATABASE_URL is missing', async () => {
    vi.doMock('@/lib/dbprobe', () => ({
      probeDatabase: async () => ({
        error: new MyError(503, 'DATABASE_URL is not set'),
      }),
    }))
    const { POST } = await import('./route')
    const res = await POST()
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      success: false,
      title: 'Service Unavailable',
      status: 503,
      detail: 'DATABASE_URL is not set',
    })
  })

  it('returns 200 with ok:true when reachable and records exists', async () => {
    vi.doMock('@/lib/dbprobe', () => ({
      probeDatabase: async () => ({
        ok: true,
        database_reachable: true,
        records_table_exists: true,
        connect_ms: 12.4,
        select1_first_ms: 45.2,
        select1_second_ms: 3.1,
      }),
    }))
    const { POST } = await import('./route')
    const res = await POST()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      database_reachable: true,
      records_table_exists: true,
      connect_ms: 12.4,
      select1_first_ms: 45.2,
      select1_second_ms: 3.1,
    })
  })

  it('returns 200 with ok:false when table missing', async () => {
    vi.doMock('@/lib/dbprobe', () => ({
      probeDatabase: async () => ({
        ok: false,
        database_reachable: true,
        records_table_exists: false,
        connect_ms: 1,
        select1_first_ms: 2,
        select1_second_ms: 3,
      }),
    }))
    const { POST } = await import('./route')
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.records_table_exists).toBe(false)
  })
})
