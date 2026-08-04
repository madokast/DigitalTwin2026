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
