import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/httpjson'
import { validateRename } from '@/lib/tags'
import { renameAcrossRecords } from '@/lib/tagsdb'
import { rejectUnknownKeys } from '@/lib/unknown-keys'

const RENAME_KEYS = ['from', 'to'] as const

export async function POST(request: NextRequest) {
  try {
    const parsed = await readJsonBody(request)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    }

    const unknown = rejectUnknownKeys(parsed.value, RENAME_KEYS)
    if (unknown) {
      return NextResponse.json({ error: unknown.error }, { status: 400 })
    }

    const body = parsed.value as { from?: unknown; to?: unknown }
    const from = typeof body.from === 'string' ? body.from.trim() : ''
    const to = typeof body.to === 'string' ? body.to.trim() : ''

    const validation = validateRename(from, to)
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const updated = await renameAcrossRecords(from, to)

    return NextResponse.json({
      success: true,
      updated,
    })
  } catch (error) {
    console.error('Error renaming tags:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
