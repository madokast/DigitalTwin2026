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
  happenedAt: '2026-07-31T12:00:00.000Z',
  valueNumber: '72.5',
  valueText: null,
  tags: '["weight"]',
  objectiveContext: 'Scale',
  subjectiveInterpretation: null,
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
  value_number: '75.5',
  tags: ['weight'],
  objective_context: 'morning weigh-in',
}

beforeEach(() => {
  createNumber.mockReset()
  scheduleBestEffortNotify.mockReset()
  notifyRecordInserted.mockReset()
  createNumber.mockResolvedValue({ status: 201, record: sampleRecord })
})

describe('POST /api/log/number suppress_notification', () => {
  it('returns 400 before create when field is non-boolean', async () => {
    const res = await POST(
      post({ ...validBody, suppress_notification: 'true' }),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'Invalid suppress_notification',
    })
    expect(createNumber).not.toHaveBeenCalled()
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })

  it('skips scheduleBestEffortNotify when true', async () => {
    const res = await POST(
      post({ ...validBody, suppress_notification: true }),
    )
    expect(res.status).toBe(201)
    expect(createNumber).toHaveBeenCalledTimes(1)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
  })

  it('schedules notify when omitted', async () => {
    const res = await POST(post(validBody))
    expect(res.status).toBe(201)
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
  })

  it('schedules notify when false', async () => {
    const res = await POST(
      post({ ...validBody, suppress_notification: false }),
    )
    expect(res.status).toBe(201)
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
  })
})
