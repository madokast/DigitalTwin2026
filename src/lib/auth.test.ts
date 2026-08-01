import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import {
  unauthorizedResponse,
  verifyAdminAccess,
  verifyApiAccess,
} from './auth'

function requestWithAuth(header?: string): NextRequest {
  const headers = new Headers()
  if (header !== undefined) {
    headers.set('Authorization', header)
  }
  return new NextRequest('http://localhost/api/query', { headers })
}

describe('verifyApiAccess', () => {
  const ai = process.env.DIGITAL_TWIN_TOKEN!
  const admin = process.env.DIGITAL_TWIN_ADMIN_TOKEN!

  it('rejects missing Authorization header', () => {
    expect(verifyApiAccess(requestWithAuth())).toBe(false)
  })

  it('rejects non-Bearer scheme', () => {
    expect(verifyApiAccess(requestWithAuth(`Token ${ai}`))).toBe(false)
  })

  it('rejects wrong token', () => {
    expect(verifyApiAccess(requestWithAuth('Bearer wrong-token'))).toBe(false)
  })

  it('accepts AI token', () => {
    expect(verifyApiAccess(requestWithAuth(`Bearer ${ai}`))).toBe(true)
  })

  it('trims trailing whitespace on Bearer token (align with Go)', () => {
    expect(verifyApiAccess(requestWithAuth(`Bearer ${ai} `))).toBe(true)
    expect(verifyApiAccess(requestWithAuth(`Bearer  ${ai}`))).toBe(true)
  })

  it('accepts admin token', () => {
    expect(verifyApiAccess(requestWithAuth(`Bearer ${admin}`))).toBe(true)
  })
})

describe('verifyAdminAccess', () => {
  const ai = process.env.DIGITAL_TWIN_TOKEN!
  const admin = process.env.DIGITAL_TWIN_ADMIN_TOKEN!

  it('rejects AI token', () => {
    expect(verifyAdminAccess(requestWithAuth(`Bearer ${ai}`))).toBe(false)
  })

  it('accepts admin token', () => {
    expect(verifyAdminAccess(requestWithAuth(`Bearer ${admin}`))).toBe(true)
  })

  it('rejects missing token', () => {
    expect(verifyAdminAccess(requestWithAuth())).toBe(false)
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
