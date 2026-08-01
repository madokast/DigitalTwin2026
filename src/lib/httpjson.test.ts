import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { INVALID_JSON_BODY, readJsonBody } from '@/lib/httpjson'

function req(body?: string): NextRequest {
  if (body === undefined) {
    return new NextRequest('http://localhost/', { method: 'POST' })
  }
  return new NextRequest('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

describe('readJsonBody', () => {
  it('returns plain object', async () => {
    await expect(readJsonBody(req('{"a":1}'))).resolves.toEqual({
      ok: true,
      value: { a: 1 },
    })
  })

  it('coerces JSON null to empty object (Go zero-value)', async () => {
    await expect(readJsonBody(req('null'))).resolves.toEqual({
      ok: true,
      value: {},
    })
  })

  it('rejects empty / malformed / non-object', async () => {
    for (const body of ['', '{', '[]', '"x"', '123', 'true']) {
      await expect(readJsonBody(req(body))).resolves.toEqual({
        ok: false,
        error: INVALID_JSON_BODY,
        status: 400,
      })
    }
  })
})
