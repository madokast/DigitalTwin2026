import { NextRequest, NextResponse } from 'next/server'
import { v7 as uuidv7 } from 'uuid'
import db from '@/db'
import { records } from '@/db/schema'
import { verifyToken, unauthorizedResponse } from '@/lib/auth'

interface LogNumberRequest {
  happened_at: string
  value_number: number
  tags: string[]
  objective_context: string
  subjective_interpretation?: string
}

export async function POST(request: NextRequest) {
  // 验证 token
  if (!verifyToken(request)) {
    return unauthorizedResponse()
  }
  
  try {
    const body: LogNumberRequest = await request.json()
    
    // 验证必填字段
    if (!body.happened_at) {
      return NextResponse.json(
        { error: 'Missing required field: happened_at' },
        { status: 400 }
      )
    }
    
    if (body.value_number === undefined || body.value_number === null) {
      return NextResponse.json(
        { error: 'Missing required field: value_number' },
        { status: 400 }
      )
    }
    
    if (!body.tags || !Array.isArray(body.tags) || body.tags.length === 0) {
      return NextResponse.json(
        { error: 'Missing required field: tags (non-empty array)' },
        { status: 400 }
      )
    }
    
    if (!body.objective_context) {
      return NextResponse.json(
        { error: 'Missing required field: objective_context' },
        { status: 400 }
      )
    }
    
    // 插入记录
    const result = await db.insert(records).values({
      id: uuidv7(),
      happenedAt: new Date(body.happened_at),
      valueNumber: body.value_number.toString(),
      valueText: null,
      tags: JSON.stringify(body.tags),
      objectiveContext: body.objective_context,
      subjectiveInterpretation: body.subjective_interpretation || null,
    }).returning()
    
    return NextResponse.json({
      success: true,
      record: result[0],
    }, { status: 201 })
    
  } catch (error) {
    console.error('Error creating number record:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
