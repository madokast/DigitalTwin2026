import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, routeError } from '@/lib/httperror'
import { readJsonBody } from '@/lib/httpjson'
import { validateRename } from '@/lib/tags'
import { renameAcrossRecords } from '@/lib/tagsdb'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

const RENAME_KEYS = ['from', 'to'] as const

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return errorResponse(parsed.error, parsed.status)
    }

    const unknown = rejectUnknownKeys(parsed.value, RENAME_KEYS)
    if (unknown) {
      return errorResponse(unknown.error, 400)
    }

    const body = parsed.value as { from?: unknown; to?: unknown }
    const from = typeof body.from === 'string' ? body.from.trim() : ''
    const to = typeof body.to === 'string' ? body.to.trim() : ''

    const validation = validateRename(from, to)
    if (!validation.valid) {
      return errorResponse(validation.error!, 400)
    }

    const updated = await renameAcrossRecords(from, to)

    return NextResponse.json({
      success: true,
      updated,
    })
  } catch (error) {
    return routeError(error, 'rename tags')
  }
}
