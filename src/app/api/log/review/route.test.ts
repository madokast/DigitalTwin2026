import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { newValidation } from '@/lib/myerr'

const createReview = vi.fn()
const scheduleBestEffortNotify = vi.fn()
const notifyRecordInserted = vi.fn()

vi.mock('@/lib/logapi', () => ({
  createReview: (...args: unknown[]) => createReview(...args),
}))

vi.mock('@/lib/notify', () => ({
  scheduleBestEffortNotify: (...args: unknown[]) =>
    scheduleBestEffortNotify(...args),
  notifyRecordInserted: (...args: unknown[]) => notifyRecordInserted(...args),
}))

import { POST } from './route'

const sampleRecord = {
  id: '01900000-0000-7000-8000-000000000001',
  happened_at: '2026-08-09T19:00:00.000+08:00',
  raw_content: 'Weekly review text',
  tags: ['review:weekly'],
  objective_context: 'Weekly review covering 2026-08-03..2026-08-09',
  ai_analysis: null,
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/log/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validBody = {
  happened_at: '2026-08-09T19:00:00+08:00',
  cadence: 'weekly',
  raw_content: 'Weekly review text',
  objective_context: 'Weekly review covering 2026-08-03..2026-08-09',
}

beforeEach(() => {
  createReview.mockReset()
  scheduleBestEffortNotify.mockReset()
  notifyRecordInserted.mockReset()
  createReview.mockResolvedValue(sampleRecord)
})

describe('POST /api/log/review notify schedule', () => {
  it('always schedules notify on success', async () => {
    const res = await POST(post(validBody))
    expect(res.status).toBe(201)
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
    const task = scheduleBestEffortNotify.mock.calls[0][0] as () => void
    task()
    expect(notifyRecordInserted).toHaveBeenCalledWith(sampleRecord)
  })

  it('does not schedule notify when create fails', async () => {
    createReview.mockRejectedValue(newValidation('Unknown JSON key: numeric_value'))
    const res = await POST(post({ ...validBody, numeric_value: '1' }))
    expect(res.status).toBe(400)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })
})
