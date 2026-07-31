import { NextRequest, NextResponse } from 'next/server'
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { records } from '@/db/schema'
import { parseHappenedAt, parseValueNumber } from '@/lib/record-draft'
import { toApiRecord } from '@/lib/record-json'
import { validateTags } from '@/lib/tags'
import { notifyRecordInserted } from '@/lib/telegram'

interface LogNumberRequest {
  happened_at: string
  value_number: unknown
  tags: string[]
  objective_context: string
  subjective_interpretation?: string
}

export async function POST(request: NextRequest) {
  try {
    const body: LogNumberRequest = await request.json()

    const happenedResult = parseHappenedAt(body.happened_at)
    if ('error' in happenedResult) {
      return NextResponse.json(
        { error: happenedResult.error },
        { status: 400 },
      )
    }

    if (body.value_number === undefined || body.value_number === null) {
      return NextResponse.json(
        { error: 'Missing required field: value_number' },
        { status: 400 },
      )
    }
    const numberResult = parseValueNumber(body.value_number)
    if ('error' in numberResult) {
      return NextResponse.json(
        { error: numberResult.error },
        { status: 400 },
      )
    }
    if (numberResult.value === null) {
      return NextResponse.json(
        { error: 'Missing required field: value_number' },
        { status: 400 },
      )
    }

    if (!body.tags || !Array.isArray(body.tags) || body.tags.length === 0) {
      return NextResponse.json(
        { error: 'Missing required field: tags (non-empty array)' },
        { status: 400 },
      )
    }

    const tagsValidation = validateTags(body.tags)
    if (!tagsValidation.valid) {
      return NextResponse.json(
        { error: tagsValidation.error },
        { status: 400 },
      )
    }

    if (!body.objective_context) {
      return NextResponse.json(
        { error: 'Missing required field: objective_context' },
        { status: 400 },
      )
    }

    const result = await db.insert(records).values({
      id: uuidv7(),
      happenedAt: happenedResult.value,
      valueNumber: numberResult.value,
      valueText: null,
      tags: JSON.stringify(body.tags),
      objectiveContext: body.objective_context,
      subjectiveInterpretation: body.subjective_interpretation || null,
    }).returning()

    // 仅 INSERT 成功后 best-effort 通知；失败不影响 201
    await notifyRecordInserted(result[0])

    return NextResponse.json({
      success: true,
      record: toApiRecord(result[0]),
    }, { status: 201 })

  } catch (error) {
    console.error('Error creating number record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
