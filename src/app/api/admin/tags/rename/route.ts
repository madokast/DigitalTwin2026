import { NextRequest, NextResponse } from 'next/server'
import { renameAcrossRecords, validateRename } from '@/lib/tags'

interface RenameTagsRequest {
  from?: string
  to?: string
}

export async function POST(request: NextRequest) {
  try {
    const body: RenameTagsRequest = await request.json()
    const from = body.from?.trim() ?? ''
    const to = body.to?.trim() ?? ''

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
