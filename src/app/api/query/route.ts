import { NextRequest, NextResponse } from 'next/server'
import { sql, and, gte, lt, like } from 'drizzle-orm'
import db from '@/db'
import { records } from '@/db/schema'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const tags = searchParams.getAll('tag')
    const q = searchParams.get('q')
    
    // 构建查询条件
    const conditions = []
    
    // 时间过滤
    if (from) {
      conditions.push(gte(records.happenedAt, new Date(from)))
    }
    if (to) {
      conditions.push(lt(records.happenedAt, new Date(to)))
    }
    
    // tag 过滤（AND 语义）
    for (const tag of tags) {
      conditions.push(like(records.tags, `%"${tag}"%`))
    }
    
    // 模糊搜索
    if (q) {
      const searchPattern = `%${q}%`
      conditions.push(
        sql`${records.valueText} LIKE ${searchPattern} OR ${records.objectiveContext} LIKE ${searchPattern} OR ${records.subjectiveInterpretation} LIKE ${searchPattern} OR ${records.tags} LIKE ${searchPattern}`
      )
    }
    
    // 执行查询
    const results = conditions.length > 0
      ? await db.select().from(records).where(and(...conditions)).orderBy(records.happenedAt)
      : await db.select().from(records).orderBy(records.happenedAt)
    
    return NextResponse.json({
      success: true,
      count: results.length,
      records: results,
    })
    
  } catch (error) {
    console.error('Error querying records:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
