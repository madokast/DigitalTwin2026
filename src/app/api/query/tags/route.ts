import { NextResponse } from 'next/server'
import { fetchTagCounts } from '@/lib/query'

export async function GET() {
  try {
    const tags = await fetchTagCounts()

    return NextResponse.json({
      success: true,
      tags,
    })
  } catch (error) {
    console.error('Error aggregating tags:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
