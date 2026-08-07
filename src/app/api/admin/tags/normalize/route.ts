import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { validateNormalize } from '@/lib/tags'
import { tagsService } from '@/lib/tagsdb'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

const NORMALIZE_KEYS = ['from', 'to'] as const

/**
 * 全表 tag 归一化（POST /api/admin/tags/normalize；AdminToken）。
 * 校验顺序（docs/20260805-tag-design.md §tag 归一化）：未知键 → from 形状（缺失/非数组/空）
 * → to 缺失 → from 元素（非法/重复/保留）→ to（非法/保留）→ 交集——全部零 DB。
 * to 必填非空（纯删除 from 系列不支持——单条删除走 tags add/remove 接口）。
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const unknown = rejectUnknownKeys(parsed.value, NORMALIZE_KEYS)
    if (unknown) {
      return errorResponse(unknown.error, 400)
    }

    const body = parsed.value as { from?: unknown; to?: unknown }
    if (!Array.isArray(body.from) || body.from.some((item) => typeof item !== 'string')) {
      return errorResponse('from must be an array of strings', 400)
    }
    const from = (body.from as string[]).map((item) => item.trim())
    const to = typeof body.to === 'string' ? body.to.trim() : ''

    const validation = validateNormalize(from, to)
    if (!validation.valid) {
      return errorResponse(validation.error, 400)
    }

    const updated = await tagsService.normalizeAcrossRecords(from, to)

    return NextResponse.json({
      success: true,
      updated,
    })
  } catch (error) {
    return routeError(error, 'normalize tags')
  }
}
