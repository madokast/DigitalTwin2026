import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as postTagsAdd } from '@/app/api/log/tags/add/route'
import { POST as postTagsRemove } from '@/app/api/log/tags/remove/route'
import { newNotFound } from '@/lib/myerr'

vi.mock('@/lib/tagsdb', () => ({
  tagsService: { attachTag: vi.fn(), detachTag: vi.fn() },
}))

vi.mock('@/lib/notify', () => ({
  notifyTagsEdited: vi.fn(),
  scheduleBestEffortNotify: (task: () => Promise<void>) => void task(),
}))

import { tagsService } from '@/lib/tagsdb'
import { notifyTagsEdited as notifyTagsEditedReal } from '@/lib/notify'

const attachTag = tagsService.attachTag as ReturnType<typeof vi.fn>
const detachTag = tagsService.detachTag as ReturnType<typeof vi.fn>
const notifyTagsEdited = notifyTagsEditedReal as ReturnType<typeof vi.fn>

/** 与 Go httpx tags_edit_test.go 对齐的 handler 单测（fake service，校验/成功路径零 DB） */
function rawPost(url: string, body: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

const validID = '01900000-0000-7000-8000-000000000003'

describe('POST /api/log/tags/add', () => {
  beforeEach(() => {
    attachTag.mockReset()
    notifyTagsEdited.mockReset()
  })

  it('add success returns full shape and notifies', async () => {
    attachTag.mockResolvedValue({
      from: ['exercise'],
      to: ['exercise', 'workout:arm'],
      changed: true,
    })
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: validID, tag: 'workout:arm' })),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      success: true,
      id: validID,
      changed: true,
      tags: { from: ['exercise'], to: ['exercise', 'workout:arm'] },
    })
    expect(attachTag).toHaveBeenCalledWith(validID, 'workout:arm')
    expect(notifyTagsEdited).toHaveBeenCalledWith('add', validID, 'workout:arm', ['exercise'], ['exercise', 'workout:arm'])
  })

  it('duplicate returns changed:false and skips notify', async () => {
    attachTag.mockResolvedValue({ from: ['a'], to: ['a'], changed: false })
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: validID, tag: 'a' })),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changed).toBe(false)
    expect(notifyTagsEdited).not.toHaveBeenCalled()
  })

  it('missing record → 404 problem+json', async () => {
    attachTag.mockRejectedValue(newNotFound(`record ${validID} not found`))
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: validID, tag: 't' })),
    )
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      success: false,
      title: 'Not Found',
      status: 404,
      detail: `record ${validID} not found`,
    })
  })

  it('unknown key → 400', async () => {
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: validID, tag: 't', extra: 1 })),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.detail).toBe('Unknown JSON key: extra')
    expect(attachTag).not.toHaveBeenCalled()
  })

  it('invalid id → 400', async () => {
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: 'not-a-uuid', tag: 't' })),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.detail).toBe('invalid record id')
    expect(attachTag).not.toHaveBeenCalled()
  })

  it('invalid tag → 400', async () => {
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: validID, tag: 'bad tag' })),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.detail).toBe(
      'invalid tag: "bad tag". Tags must contain only letters, numbers, underscores, and cannot start with a number.',
    )
    expect(attachTag).not.toHaveBeenCalled()
  })

  it('reserved tag → 400', async () => {
    const res = await postTagsAdd(
      rawPost('http://localhost/api/log/tags/add', JSON.stringify({ id: validID, tag: 'body:weight' })),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.detail).toBe(
      'tag "body:weight" is reserved; use the dedicated log API for this record type',
    )
    expect(attachTag).not.toHaveBeenCalled()
  })

  it('malformed body → 400', async () => {
    const res = await postTagsAdd(rawPost('http://localhost/api/log/tags/add', '{not-json'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.detail).toBe('invalid JSON body')
    expect(attachTag).not.toHaveBeenCalled()
  })
})

describe('POST /api/log/tags/remove', () => {
  beforeEach(() => {
    detachTag.mockReset()
    notifyTagsEdited.mockReset()
  })

  it('remove success notifies with remove action', async () => {
    detachTag.mockResolvedValue({
      from: ['exercise', 'workout:arm'],
      to: ['exercise'],
      changed: true,
    })
    const res = await postTagsRemove(
      rawPost('http://localhost/api/log/tags/remove', JSON.stringify({ id: validID, tag: 'workout:arm' })),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      success: true,
      id: validID,
      changed: true,
      tags: { from: ['exercise', 'workout:arm'], to: ['exercise'] },
    })
    expect(notifyTagsEdited).toHaveBeenCalledWith('remove', validID, 'workout:arm', ['exercise', 'workout:arm'], ['exercise'])
  })

  it('absent tag returns changed:false and skips notify', async () => {
    detachTag.mockResolvedValue({ from: ['a'], to: ['a'], changed: false })
    const res = await postTagsRemove(
      rawPost('http://localhost/api/log/tags/remove', JSON.stringify({ id: validID, tag: 'zzz' })),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changed).toBe(false)
    expect(notifyTagsEdited).not.toHaveBeenCalled()
  })

  it('reserved tag rejected symmetrically', async () => {
    const res = await postTagsRemove(
      rawPost('http://localhost/api/log/tags/remove', JSON.stringify({ id: validID, tag: 'todo:in_progress' })),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.detail).toBe(
      'tag "todo:in_progress" is reserved; use the dedicated log API for this record type',
    )
    expect(detachTag).not.toHaveBeenCalled()
  })
})
