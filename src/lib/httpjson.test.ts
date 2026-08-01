import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { INVALID_JSON_BODY, MAX_HTTP_BODY_BYTES, readJsonBody, REQUEST_BODY_TOO_LARGE } from '@/lib/httpjson'

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

  it('rejects valid JSON followed by trailing garbage', async () => {
    await expect(readJsonBody(req('{"a":1} xyz'))).resolves.toEqual({
      ok: false,
      error: INVALID_JSON_BODY,
      status: 400,
    })
  })

  it('rejects bodies larger than 256 KiB with 413', async () => {
    const oversized = 'a'.repeat(MAX_HTTP_BODY_BYTES + 1)
    await expect(readJsonBody(req(oversized))).resolves.toEqual({
      ok: false,
      error: REQUEST_BODY_TOO_LARGE,
      status: 413,
    })
  })

  it('accepts body of exactly 256 KiB when it is a JSON object', async () => {
    const pad = MAX_HTTP_BODY_BYTES - 2
    const body = `{${' '.repeat(pad)}}`
    expect(body.length).toBe(MAX_HTTP_BODY_BYTES)
    await expect(readJsonBody(req(body))).resolves.toEqual({
      ok: true,
      value: {},
    })
  })
})
