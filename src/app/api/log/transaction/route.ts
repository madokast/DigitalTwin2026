import { NextRequest, NextResponse } from 'next/server'
import { createTransactionBatch } from '@/lib/logapi'
import { notifyTransactionBatchInserted } from '@/lib/telegram'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const result = await createTransactionBatch(body)
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    await notifyTransactionBatchInserted(result.records)

    return NextResponse.json(
      { success: true, inserted: result.inserted },
      { status: result.status },
    )
  } catch (error) {
    console.error('Error creating transaction records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
