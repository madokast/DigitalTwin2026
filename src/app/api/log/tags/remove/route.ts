import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { INVALID_RECORD_ID, isValidRecordId } from '@/lib/record'
import { assertNoReservedTags, invalidTagMessage, isValidTag } from '@/lib/tags'
import { tagsService } from '@/lib/tagsdb'
import { rejectUnknownKeys } from '@/lib/unknown-keys'
import { notifyTagsEdited, scheduleBestEffortNotify } from '@/lib/notify'

const TAGS_EDIT_KEYS = ['id', 'tag'] as const

/**
 * 删单个普通 tag（POST /api/log/tags/remove）。校验与 add 对称（tags-add.md §语义：
 * 保留前缀禁止删；tag 不存在 → changed:false 一律 200）。
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const unknown = rejectUnknownKeys(parsed.value, TAGS_EDIT_KEYS)
    if (unknown) {
      return errorResponse(unknown.error, 400)
    }

    const body = parsed.value as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const tag = typeof body.tag === 'string' ? body.tag.trim() : ''
    if (!isValidRecordId(id)) {
      return errorResponse(INVALID_RECORD_ID, 400)
    }
    if (!isValidTag(tag)) {
      return errorResponse(invalidTagMessage(tag), 400)
    }
    const reserved = assertNoReservedTags([tag])
    if (!reserved.valid) {
      return errorResponse(reserved.error, 400)
    }

    const result = await tagsService.detachTag(id, tag)
    if (result.changed) {
      scheduleBestEffortNotify(() =>
        notifyTagsEdited('remove', id, tag, result.from, result.to),
      )
    }
    return NextResponse.json(
      {
        success: true,
        id,
        changed: result.changed,
        tags: { from: result.from, to: result.to },
      },
      { status: 200 },
    )
  } catch (error) {
    return routeError(error, 'tags edit')
  }
}
