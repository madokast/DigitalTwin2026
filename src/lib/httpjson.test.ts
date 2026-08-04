import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { INVALID_JSON_BODY, MAX_HTTP_BODY_BYTES, readJsonBody, REQUEST_BODY_TOO_LARGE } from '@/lib/httpjson'
import { BODY_MUST_BE_OBJECT } from '@/lib/unknown-keys'

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

  it('rejects JSON null with body-must-be-object (Go RejectUnknownObjectKeys)', async () => {
    await expect(readJsonBody(req('null'))).resolves.toEqual({
      ok: false,
      error: BODY_MUST_BE_OBJECT,
      status: 400,
    })
  })

  it('rejects empty / malformed with Invalid JSON body', async () => {
    for (const body of ['', '{']) {
      await expect(readJsonBody(req(body))).resolves.toEqual({
        ok: false,
        error: INVALID_JSON_BODY,
        status: 400,
      })
    }
  })

  it('rejects non-object JSON (array / literal) with body-must-be-object', async () => {
    for (const body of ['[]', '"x"', '123', 'true']) {
      await expect(readJsonBody(req(body))).resolves.toEqual({
        ok: false,
        error: BODY_MUST_BE_OBJECT,
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
