import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const transitionTodo = vi.fn()
const scheduleBestEffortNotify = vi.fn()
const notify_user = vi.fn()

vi.mock('@/lib/logapi', () => ({
  transitionTodo: (...args: unknown[]) => transitionTodo(...args),
}))

vi.mock('@/lib/notify', () => ({
  scheduleBestEffortNotify: (...args: unknown[]) =>
    scheduleBestEffortNotify(...args),
  notify_user: (...args: unknown[]) => notify_user(...args),
}))

import { POST } from './route'

const todoId = '01900000-0000-7000-8000-000000000003'
const auditText =
  'Complete a to-do created at 2026-08-02T02:00:00.000Z: Buy milk'

const validBody = {
  id: todoId,
  target: 'completed',
  happened_at: '2026-08-02T12:00:00+08:00',
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/log/todo/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  transitionTodo.mockReset()
  scheduleBestEffortNotify.mockReset()
  notify_user.mockReset()
  scheduleBestEffortNotify.mockImplementation((task: () => Promise<void>) => {
    void task()
  })
  transitionTodo.mockResolvedValue({
    status: 200,
    id: todoId,
    from: 'in_progress',
    to: 'completed',
    auditValueText: auditText,
  })
})

describe('POST /api/log/todo/transition', () => {
  it('returns 200 success body without record / audit_record', async () => {
    const res = await POST(post(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      success: true,
      id: todoId,
      transition: { from: 'in_progress', to: 'completed' },
    })
    expect(body).not.toHaveProperty('record')
    expect(body).not.toHaveProperty('audit_record')
  })

  it('notifies once with exact audit value_text', async () => {
    const res = await POST(post(validBody))
    expect(res.status).toBe(200)
    expect(scheduleBestEffortNotify).toHaveBeenCalledTimes(1)
    expect(notify_user).toHaveBeenCalledTimes(1)
    expect(notify_user).toHaveBeenCalledWith(auditText)
  })

  it('skips notify when suppress_notification is true', async () => {
    const res = await POST(
      post({ ...validBody, suppress_notification: true }),
    )
    expect(res.status).toBe(200)
    expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
    expect(notify_user).not.toHaveBeenCalled()
  })

  it('returns four domain errors with exact English strings', async () => {
    const cases = [
      { error: 'to-do not found', status: 404 },
      { error: 'record is not a to-do', status: 400 },
      { error: 'cannot transition a to-do audit record', status: 400 },
      { error: 'to-do is already in target state', status: 400 },
    ] as const
    for (const c of cases) {
      transitionTodo.mockResolvedValueOnce({ error: c.error, status: c.status })
      const res = await POST(post(validBody))
      expect(res.status).toBe(c.status)
      await expect(res.json()).resolves.toEqual({ error: c.error })
      expect(scheduleBestEffortNotify).not.toHaveBeenCalled()
    }
  })

  it('returns 400 before transition when suppress_notification is non-boolean', async () => {
    const res = await POST(
      post({ ...validBody, suppress_notification: 'true' }),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'Invalid suppress_notification',
    })
    expect(transitionTodo).not.toHaveBeenCalled()
  })
})
