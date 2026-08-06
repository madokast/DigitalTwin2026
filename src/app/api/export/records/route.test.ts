import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { newNotFound } from '@/lib/myerr'

const parseExportRecordsParams = vi.fn()
const fetchExportRecords = vi.fn()
const buildExportNdjson = vi.fn()
const exportContentDisposition = vi.fn()
const formatExportNotifyMessage = vi.fn()
const scheduleBestEffortNotify = vi.fn()
const notify_user = vi.fn()

vi.mock('@/lib/exportapi', () => ({
  parseExportRecordsParams: (...args: unknown[]) =>
    parseExportRecordsParams(...args),
  fetchExportRecords: (...args: unknown[]) => fetchExportRecords(...args),
  buildExportNdjson: (...args: unknown[]) => buildExportNdjson(...args),
  exportContentDisposition: (...args: unknown[]) =>
    exportContentDisposition(...args),
  formatExportNotifyMessage: (...args: unknown[]) =>
    formatExportNotifyMessage(...args),
}))

vi.mock('@/lib/notify', () => ({
  scheduleBestEffortNotify: (...args: unknown[]) =>
    scheduleBestEffortNotify(...args),
  notify_user: (...args: unknown[]) => notify_user(...args),
}))

import { GET } from './route'

function get(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

const sampleRecord = {
  id: '01900000-0000-7000-8000-000000000001',
  happenedAt: '2026-07-30T00:00:00.000Z',
  numericValue: '1',
  rawContent: null,
  tags: '[]',
  objectiveContext: 'x',
  aiAnalysis: null,
}

beforeEach(() => {
  parseExportRecordsParams.mockReset()
  fetchExportRecords.mockReset()
  buildExportNdjson.mockReset()
  exportContentDisposition.mockReset()
  formatExportNotifyMessage.mockReset()
  scheduleBestEffortNotify.mockReset()
  notify_user.mockReset()

  parseExportRecordsParams.mockReturnValue({ from: null, limit: 100 })
  fetchExportRecords.mockResolvedValue({
    records: [sampleRecord],
    status: 200,
  })
  buildExportNdjson.mockReturnValue('{"id":"…"}\n')
  exportContentDisposition.mockReturnValue(
    'attachment; filename="records-from-start-limit-100-20260803T000000Z.jsonl"',
  )
  formatExportNotifyMessage.mockReturnValue(
    'Exported 1 records (from start, limit 100)',
  )
})

describe('GET /api/export/records notify schedule', () => {
  it('schedules notify only after successful 200 response is built', async () => {
    fetchExportRecords.mockResolvedValue({ records: [], status: 200 })
    buildExportNdjson.mockReturnValue('')
    formatExportNotifyMessage.mockReturnValue(
      'Exported 0 records (from start, limit 100)',
    )

    const res = await GET(get('http://localhost/api/export/records?limit=100'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(await res.text()).toBe('')
    // 响应已构造成功后才 schedule（对齐 §4.5）
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
    const task = scheduleBestEffortNotify.mock.calls[0][0] as () => void
    task()
    expect(notify_user).toHaveBeenCalledWith(
      'Exported 0 records (from start, limit 100)',
    )
  })

  it('does not schedule notify on parse error', async () => {
    parseExportRecordsParams.mockReturnValue({
      error: 'limit must be an integer between 1 and 1000',
    })
    const res = await GET(get('http://localhost/api/export/records'))
    expect(res.status).toBe(400)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })

  it('does not schedule notify when from id not found', async () => {
    parseExportRecordsParams.mockReturnValue({
      from: '01900000-0000-7000-8000-000000000099',
      limit: 10,
    })
    fetchExportRecords.mockRejectedValue(newNotFound('export from id not found'))
    const res = await GET(
      get(
        'http://localhost/api/export/records?from=01900000-0000-7000-8000-000000000099&limit=10',
      ),
    )
    expect(res.status).toBe(404)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })
})
