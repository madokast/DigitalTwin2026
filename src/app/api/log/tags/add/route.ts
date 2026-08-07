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
 * 补单个普通 tag（POST /api/log/tags/add）。
 * 校验顺序（docs/20260805-tags-add.md §校验顺序）：未知键 → id 格式 → tag 合法 → 保留前缀
 * （全部零 DB）→ TagsService（UoW 事务 + Repo 原语）→ changed:true 才通知。
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

    const result = await tagsService.attachTag(id, tag)
    if (result.changed) {
      scheduleBestEffortNotify(() =>
        notifyTagsEdited('add', id, tag, result.from, result.to),
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
