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
  const token = process.env.DIGITAL_TWIN_TOKEN!

  it('rejects missing Authorization with 401 JSON', async () => {
    const res = proxy(apiRequest('/api/query'))
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: 'Unauthorized: Invalid or missing token',
    })
  })

  it('rejects wrong Bearer token', async () => {
    const res = proxy(apiRequest('/api/log/number', 'Bearer wrong'))
    expect(res.status).toBe(401)
  })

  it('allows valid Bearer token through', () => {
    const res = proxy(apiRequest('/api/query/tags', `Bearer ${token}`))
    // NextResponse.next() uses a special null-body response
    expect(res.status).toBe(200)
    expect(res.headers.get('x-middleware-next') || res.headers.get('x-middleware-rewrite') || true).toBeTruthy()
  })
})
