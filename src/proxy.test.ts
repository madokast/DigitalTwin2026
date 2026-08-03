import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from './proxy'

function apiRequest(path: string, authorization?: string): NextRequest {
  const headers = new Headers()
  if (authorization !== undefined) {
    headers.set('Authorization', authorization)
  }
  return new NextRequest(`http://localhost${path}`, { headers })
}

describe('proxy API auth', () => {
  const ai = process.env.DIGITAL_TWIN_TOKEN!
  const admin = process.env.DIGITAL_TWIN_ADMIN_TOKEN!

  it('rejects missing Authorization with 401 JSON', async () => {
    const res = proxy(apiRequest('/api/query'))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: 'Unauthorized: Invalid or missing token',
    })
  })

  it('rejects wrong Bearer token on normal API', async () => {
    const res = proxy(apiRequest('/api/log/number', 'Bearer wrong'))
    expect(res.status).toBe(401)
  })

  it('allows AI token on normal API', () => {
    const res = proxy(apiRequest('/api/query/tags', `Bearer ${ai}`))
    expect(res.status).toBe(200)
  })

  it('allows AI token on POST /api/telegram/probe (non-admin)', () => {
    const res = proxy(apiRequest('/api/telegram/probe', `Bearer ${ai}`))
    expect(res.status).toBe(200)
  })

  it('allows AI token on POST /api/db/probe (non-admin)', () => {
    const res = proxy(apiRequest('/api/db/probe', `Bearer ${ai}`))
    expect(res.status).toBe(200)
  })

  it('allows admin token on normal API', () => {
    const res = proxy(apiRequest('/api/query', `Bearer ${admin}`))
    expect(res.status).toBe(200)
  })

  it('rejects AI token on /api/admin', () => {
    const res = proxy(apiRequest('/api/admin/tags/rename', `Bearer ${ai}`))
    expect(res.status).toBe(401)
  })

  it('rejects AI token on PATCH /api/admin/records/:id', () => {
    const res = proxy(
      apiRequest('/api/admin/records/01900000-0000-7000-8000-000000000000', `Bearer ${ai}`),
    )
    expect(res.status).toBe(401)
  })

  it('rejects AI token on POST /api/admin/import/records', () => {
    const res = proxy(
      apiRequest('/api/admin/import/records', `Bearer ${ai}`),
    )
    expect(res?.status).toBe(401)
  })

  it('allows admin token on /api/admin', () => {
    const res = proxy(apiRequest('/api/admin/tags/rename', `Bearer ${admin}`))
    expect(res.status).toBe(200)
  })

  it('does not treat /api/administration as admin route', () => {
    const res = proxy(apiRequest('/api/administration', `Bearer ${ai}`))
    expect(res.status).toBe(200)
  })
})
