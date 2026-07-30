import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { unauthorizedResponse, verifyToken } from './auth'

function requestWithAuth(header?: string): NextRequest {
  const headers = new Headers()
  if (header !== undefined) {
    headers.set('Authorization', header)
  }
  return new NextRequest('http://localhost/api/query', { headers })
}

describe('verifyToken', () => {
  const token = process.env.DIGITAL_TWIN_TOKEN!

  it('rejects missing Authorization header', () => {
    expect(verifyToken(requestWithAuth())).toBe(false)
  })

  it('rejects non-Bearer scheme', () => {
    expect(verifyToken(requestWithAuth(`Token ${token}`))).toBe(false)
  })

  it('rejects wrong token', () => {
    expect(verifyToken(requestWithAuth('Bearer wrong-token'))).toBe(false)
  })

  it('accepts correct Bearer token', () => {
    expect(verifyToken(requestWithAuth(`Bearer ${token}`))).toBe(true)
  })
})

describe('unauthorizedResponse', () => {
  it('returns 401 JSON', async () => {
    const res = unauthorizedResponse()
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: 'Unauthorized: Invalid or missing token',
    })
  })
})
