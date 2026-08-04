import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const createNumber = vi.fn()
const scheduleBestEffortNotify = vi.fn()
const notifyRecordInserted = vi.fn()

vi.mock('@/lib/logapi', () => ({
  createNumber: (...args: unknown[]) => createNumber(...args),
}))

vi.mock('@/lib/notify', () => ({
  scheduleBestEffortNotify: (...args: unknown[]) =>
    scheduleBestEffortNotify(...args),
  notifyRecordInserted: (...args: unknown[]) => notifyRecordInserted(...args),
}))

import { POST } from './route'

const sampleRecord = {
  id: '01900000-0000-7000-8000-000000000001',
  happened_at: '2026-07-31T12:00:00.000Z',
  numeric_value: '72.5',
  raw_content: null,
  tags: '["weight"]',
  objective_context: 'Scale',
  subjective_interpretation: null,
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/log/number', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validBody = {
  happened_at: '2026-07-30T08:00:00+08:00',
  numeric_value: '75.5',
  tags: ['weight'],
  objective_context: 'morning weigh-in',
}

beforeEach(() => {
  createNumber.mockReset()
  scheduleBestEffortNotify.mockReset()
  notifyRecordInserted.mockReset()
  createNumber.mockResolvedValue({ status: 201, record: sampleRecord })
})

describe('POST /api/log/number notify schedule', () => {
  it('always schedules notify on success', async () => {
    const res = await POST(post(validBody))
    expect(res.status).toBe(201)
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
    const task = scheduleBestEffortNotify.mock.calls[0][0] as () => void
    task()
    expect(notifyRecordInserted).toHaveBeenCalledWith(sampleRecord)
  })

  it('does not schedule notify when create fails', async () => {
    createNumber.mockResolvedValue({
      error: 'Unknown JSON key: suppress_notification',
      status: 400,
    })
    const res = await POST(
      post({ ...validBody, suppress_notification: true }),
    )
    expect(res.status).toBe(400)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })
})
