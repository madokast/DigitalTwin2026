import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { newValidation } from '@/lib/myerr'

const createNumberBatch = vi.fn()
const scheduleBestEffortNotify = vi.fn()
const notifyNumberBatchInserted = vi.fn()

vi.mock('@/lib/logapi', () => ({
  logService: {
    createNumberBatch: (...args: unknown[]) => createNumberBatch(...args),
  },
}))

vi.mock('@/lib/notify', () => ({
  scheduleBestEffortNotify: (...args: unknown[]) =>
    scheduleBestEffortNotify(...args),
  notifyNumberBatchInserted: (...args: unknown[]) =>
    notifyNumberBatchInserted(...args),
}))

import { POST } from './route'

const sampleRecord = {
  id: '01900000-0000-7000-8000-000000000001',
  happened_at: '2026-08-05T10:00:00+08:00',
  numeric_value: '36.8',
  raw_content: null,
  tags: [],
  objective_context: 'axillary',
  ai_analysis: null,
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/log/numbers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validBody = {
  happened_at: '2026-08-05T10:00:00+08:00',
  entries: [{ numeric_value: '36.8', memo: 'axillary temperature' }],
}

beforeEach(() => {
  createNumberBatch.mockReset()
  scheduleBestEffortNotify.mockReset()
  notifyNumberBatchInserted.mockReset()
  createNumberBatch.mockResolvedValue({
    inserted: 1,
    records: [sampleRecord],
  })
})

describe('POST /api/log/numbers notify schedule', () => {
  it('returns batch success shape and schedules one batch notify', async () => {
    const res = await POST(post(validBody))
    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toEqual({
      success: true,
      inserted: 1,
      atomic: true,
    })
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
    const task = scheduleBestEffortNotify.mock.calls[0][0] as () => void
    task()
    expect(notifyNumberBatchInserted).toHaveBeenCalledWith([sampleRecord])
  })

  it('does not schedule notify when create fails', async () => {
    createNumberBatch.mockRejectedValue(newValidation('entries must be a non-empty array'))
    const res = await POST(post({ ...validBody, entries: [] }))
    expect(res.status).toBe(400)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })
})
