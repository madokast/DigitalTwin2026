import { NextRequest, NextResponse } from 'next/server'
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { records } from '@/db/schema'
import { parseTransactionBatch } from '@/lib/transaction-draft'
import { notifyTransactionBatchInserted } from '@/lib/telegram'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parsed = parseTransactionBatch(body)
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const inserted = await db.transaction(async (tx) => {
      const rows = []
      for (const entry of parsed.entries) {
        const result = await tx
          .insert(records)
          .values({
            id: uuidv7(),
            happenedAt: parsed.happenedAt,
            valueNumber: entry.amount,
            valueText: null,
            tags: JSON.stringify(entry.tags),
            objectiveContext: entry.memo,
            subjectiveInterpretation: null,
          })
          .returning()
        rows.push(result[0])
      }
      return rows
    })

    await notifyTransactionBatchInserted(inserted)

    return NextResponse.json(
      { success: true, inserted: inserted.length },
      { status: 201 },
    )
  } catch (error) {
    console.error('Error creating transaction records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
