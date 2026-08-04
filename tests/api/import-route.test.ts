import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as importRecords } from '@/app/api/admin/import/records/route'

/**
 * import 路由 400 边界（无 DB；对齐 Go handleImportRecords）：
 * 缺 boundary / boundary 格式非法 → 400 MULTIPART_CONTENT_TYPE，不得落 500 catch。
 */

function rawPost(contentType: string, body: string): NextRequest {
  return new NextRequest('http://localhost/api/admin/import/records', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  })
}

const TEST_BOUNDARY = 'test-boundary-xyz'

function multipartBody(
  fields: Array<{ name: string; value: string }>,
): string {
  const parts = fields.map(
    (f) =>
      `--${TEST_BOUNDARY}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`,
  )
  return `${parts.join('')}--${TEST_BOUNDARY}--\r\n`
}

function multipartContentType(): string {
  return `multipart/form-data; boundary=${TEST_BOUNDARY}`
}

describe('POST /api/admin/import/records boundary gate', () => {
  it('non-multipart Content-Type → 400', async () => {
    const res = await importRecords(rawPost('application/json', '{}'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'expected Content-Type multipart/form-data',
    })
  })

  it('multipart without boundary → 400 (was 500 via formData throw)', async () => {
    const res = await importRecords(rawPost('multipart/form-data', 'x'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'expected Content-Type multipart/form-data',
    })
  })

  it('multipart with empty boundary → 400', async () => {
    const res = await importRecords(rawPost('multipart/form-data; boundary=', 'x'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'expected Content-Type multipart/form-data',
    })
  })

  it('multipart with malformed boundary → 400 (Go ParseMediaType also 400)', async () => {
    const res = await importRecords(
      rawPost('multipart/form-data; boundary="unterminated', 'x'),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'expected Content-Type multipart/form-data',
    })
  })
})

describe('POST /api/admin/import/records non-file part size gate', () => {
  const FOUR_MIB = 4 * 1024 * 1024

  it('oversized text part without file → 400 part too large (Go order: same)', async () => {
    const res = await importRecords(
      rawPost(
        multipartContentType(),
        multipartBody([{ name: 'note', value: 'a'.repeat(FOUR_MIB + 1) }]),
      ),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'multipart non-file part exceeds size limit (max 4 MiB)',
    })
  })

  it('oversized text part before a valid file → 400 part too large', async () => {
    const line = JSON.stringify({
      id: '01900000-0000-7000-8000-000000000001',
      happened_at: '2026-07-30T00:00:00.000Z',
      value_number: '1',
      tags: ['weight'],
      objective_context: 'x',
    })
    const res = await importRecords(
      rawPost(
        multipartContentType(),
        multipartBody([
          { name: 'note', value: 'a'.repeat(FOUR_MIB + 1) },
          { name: 'file', value: line },
        ]),
      ),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'multipart non-file part exceeds size limit (max 4 MiB)',
    })
  })

  it('normal-size text part without file → 400 file required (unchanged)', async () => {
    const res = await importRecords(
      rawPost(
        multipartContentType(),
        multipartBody([{ name: 'note', value: 'hi' }]),
      ),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'multipart form field "file" is required',
    })
  })
})
