import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { newValidation } from '@/lib/myerr'

const importRecordsJsonl = vi.fn()
const formatImportNotifyMessage = vi.fn()
const isAcceptedImportFilePart = vi.fn()
const scheduleBestEffortNotify = vi.fn()
const notify_user = vi.fn()

vi.mock('@/lib/importapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/importapi')>()
  return {
    ...actual,
    importRecordsJsonl: (...args: unknown[]) => importRecordsJsonl(...args),
    formatImportNotifyMessage: (...args: unknown[]) =>
      formatImportNotifyMessage(...args),
    isAcceptedImportFilePart: (...args: unknown[]) =>
      isAcceptedImportFilePart(...args),
  }
})

vi.mock('@/lib/notify', () => ({
  scheduleBestEffortNotify: (...args: unknown[]) =>
    scheduleBestEffortNotify(...args),
  notify_user: (...args: unknown[]) => notify_user(...args),
}))

import { POST } from './route'
import {
  IMPORT_LIMITS_ERROR,
  MAX_IMPORT_FILE_BYTES,
  MULTIPART_CONTENT_TYPE,
  MULTIPART_FILE_REQUIRED,
} from '@/lib/importapi'

function multipartRequest(
  fileContent: string,
  opts?: {
    filename?: string
    type?: string
    omitFile?: boolean
    extraFile?: boolean
  },
): NextRequest {
  const form = new FormData()
  if (!opts?.omitFile) {
    const blob = new Blob([fileContent], {
      type: opts?.type ?? 'application/x-ndjson',
    })
    form.append('file', blob, opts?.filename ?? 'records.jsonl')
  }
  if (opts?.extraFile) {
    form.append(
      'file',
      new Blob(['x'], { type: 'application/x-ndjson' }),
      'other.jsonl',
    )
  }
  return new NextRequest('http://localhost/api/admin/import/records', {
    method: 'POST',
    body: form,
  })
}

beforeEach(() => {
  importRecordsJsonl.mockReset()
  formatImportNotifyMessage.mockReset()
  isAcceptedImportFilePart.mockReset()
  scheduleBestEffortNotify.mockReset()
  notify_user.mockReset()

  isAcceptedImportFilePart.mockReturnValue(true)
  importRecordsJsonl.mockResolvedValue({
    ok: true,
    counts: { inserted: 0, updated: 0, total: 0 },
  })
  formatImportNotifyMessage.mockReturnValue(
    'Imported 0 records (inserted 0, updated 0)',
  )
})

describe('POST /api/admin/import/records notify schedule', () => {
  it('schedules notify on empty success', async () => {
    const res = await POST(multipartRequest(''))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      inserted: 0,
      updated: 0,
      total: 0,
      atomic: true,
    })
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
    const task = scheduleBestEffortNotify.mock.calls[0][0] as () => void
    task()
    expect(notify_user).toHaveBeenCalledWith(
      'Imported 0 records (inserted 0, updated 0)',
    )
  })

  it('does not schedule notify on domain error', async () => {
    importRecordsJsonl.mockRejectedValue(newValidation('line 1: invalid JSON line'))
    const res = await POST(multipartRequest('{bad}'))
    expect(res.status).toBe(400)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })

  it('rejects non-multipart content type', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/admin/import/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toBe(MULTIPART_CONTENT_TYPE)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })

  it('rejects missing file part', async () => {
    const res = await POST(multipartRequest('', { omitFile: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toBe(MULTIPART_FILE_REQUIRED)
  })

  it('rejects oversized file by size before importRecordsJsonl', async () => {
    // 真实 size > 4MiB：须 400 且不得先无界交给 importRecordsJsonl。
    const big = 'a'.repeat(MAX_IMPORT_FILE_BYTES + 1)
    const res = await POST(multipartRequest(big))
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toBe(IMPORT_LIMITS_ERROR)
    expect(importRecordsJsonl).not.toHaveBeenCalled()
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })
})
