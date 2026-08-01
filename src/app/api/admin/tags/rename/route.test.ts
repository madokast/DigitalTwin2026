import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/tags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tags')>()
  return {
    ...actual,
    renameAcrossRecords: vi.fn(async () => 0),
  }
})

import { POST } from '@/app/api/admin/tags/rename/route'

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/tags/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/tags/rename type mismatches', () => {
  it('returns 400 field message for non-string from/to (not 500)', async () => {
    const res = await POST(post({ from: 123, to: 'ok_tag' }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'Missing required fields: from, to',
    })
  })

  it('returns 400 when to is non-string', async () => {
    const res = await POST(post({ from: 'ok_tag', to: 456 }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'Missing required fields: from, to',
    })
  })
})
