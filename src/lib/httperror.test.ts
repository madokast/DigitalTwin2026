import { describe, expect, it } from 'vitest'
import { errorResponse, statusTitle } from '@/lib/httperror'

describe('statusTitle', () => {
  it('returns RFC 9110 reason phrases (same mapping as Go)', () => {
    expect(statusTitle(400)).toBe('Bad Request')
    expect(statusTitle(401)).toBe('Unauthorized')
    expect(statusTitle(404)).toBe('Not Found')
    expect(statusTitle(409)).toBe('Conflict')
    expect(statusTitle(413)).toBe('Payload Too Large')
    expect(statusTitle(500)).toBe('Internal Server Error')
  })

  it('returns empty string for unknown status', () => {
    expect(statusTitle(999)).toBe('')
  })
})

describe('errorResponse', () => {
  it('builds problem+json response with success/title/status/detail in key order', async () => {
    const res = errorResponse('missing required query parameter: from', 400)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['success', 'title', 'status', 'detail'])
    expect(body).toEqual({
      success: false,
      title: 'Bad Request',
      status: 400,
      detail: 'missing required query parameter: from',
    })
  })
})
