import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as postNumber } from '@/app/api/log/number/route'
import { POST as postText } from '@/app/api/log/text/route'
import { POST as postTransaction } from '@/app/api/log/transaction/route'
import { POST as renameTags } from '@/app/api/admin/tags/rename/route'

/** 与 Go httpx「Invalid JSON body」对齐：空 body / 语法错误 → 400，而非 500 */
function rawPost(url: string, body: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

describe('malformed / empty JSON body → 400', () => {
  const cases: Array<{
    name: string
    run: (body: string) => Promise<Response>
  }> = [
    {
      name: 'POST /api/log/number',
      run: (body) => postNumber(rawPost('http://localhost/api/log/number', body)),
    },
    {
      name: 'POST /api/log/text',
      run: (body) => postText(rawPost('http://localhost/api/log/text', body)),
    },
    {
      name: 'POST /api/log/transaction',
      run: (body) =>
        postTransaction(rawPost('http://localhost/api/log/transaction', body)),
    },
    {
      name: 'POST /api/admin/tags/rename',
      run: (body) =>
        renameTags(rawPost('http://localhost/api/admin/tags/rename', body)),
    },
  ]

  for (const c of cases) {
    it(`${c.name}: empty body`, async () => {
      const res = await c.run('')
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    })

    it(`${c.name}: malformed JSON`, async () => {
      const res = await c.run('{not-json')
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    })

    it(`${c.name}: null body`, async () => {
      const res = await c.run('null')
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: 'Request body must be a JSON object',
      })
    })

    it(`${c.name}: non-object JSON (array)`, async () => {
      const res = await c.run('[]')
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: 'Request body must be a JSON object',
      })
    })

    it(`${c.name}: trailing garbage after valid JSON`, async () => {
      const res = await c.run('{"from":"a","to":"b"} xyz')
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    })

    it(`${c.name}: body larger than 256 KiB`, async () => {
      const res = await c.run('a'.repeat(256 * 1024 + 1))
      expect(res.status).toBe(413)
      await expect(res.json()).resolves.toEqual({
        error: 'Request body too large',
      })
    })
  }
})
