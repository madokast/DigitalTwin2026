import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('POST /api/db/probe', () => {
  it('returns 503 when DATABASE_URL is missing', async () => {
    vi.doMock('@/lib/dbprobe', () => ({
      probeDatabase: async () => ({
        error: 'DATABASE_URL is not set',
        status: 503 as const,
      }),
    }))
    const { POST } = await import('./route')
    const res = await POST()
    expect(res.status).toBe(503)
    await expect(res.json()).resolves.toEqual({
      error: 'DATABASE_URL is not set',
    })
  })

  it('returns 200 with ok:true when reachable and records exists', async () => {
    vi.doMock('@/lib/dbprobe', () => ({
      probeDatabase: async () => ({
        ok: true,
        databaseReachable: true,
        recordsTableExists: true,
        connectMs: 12.4,
        select1FirstMs: 45.2,
        select1SecondMs: 3.1,
      }),
    }))
    const { POST } = await import('./route')
    const res = await POST()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      databaseReachable: true,
      recordsTableExists: true,
      connectMs: 12.4,
      select1FirstMs: 45.2,
      select1SecondMs: 3.1,
    })
  })

  it('returns 200 with ok:false when table missing', async () => {
    vi.doMock('@/lib/dbprobe', () => ({
      probeDatabase: async () => ({
        ok: false,
        databaseReachable: true,
        recordsTableExists: false,
        connectMs: 1,
        select1FirstMs: 2,
        select1SecondMs: 3,
      }),
    }))
    const { POST } = await import('./route')
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.recordsTableExists).toBe(false)
  })
})
