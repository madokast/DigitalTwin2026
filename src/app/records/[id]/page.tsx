'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { fetchRecordById, type TwinRecord } from '@/lib/api-client'
import { formatHappenedAt } from '@/lib/datetime-ui'
import { resolveTimezone } from '@/lib/prefs'

export default function RecordDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [record, setRecord] = useState<TwinRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const row = await fetchRecordById(id)
        if (cancelled) return
        if (!row) {
          setError('记录不存在')
          setRecord(null)
        } else {
          setRecord(row)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [id])

  const tz = typeof window !== 'undefined' ? resolveTimezone() : 'UTC'
  let tags: string[] = []
  if (record) {
    try {
      tags = JSON.parse(record.tags)
    } catch {
      tags = []
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-4">
      <div className="mb-4">
        <Link href="/records" className="text-sm text-link hover:underline">
          ← 返回记录
        </Link>
      </div>
      <h1 className="text-xl font-bold mb-4 text-foreground">记录详情</h1>

      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {record && (
        <dl className="space-y-3 bg-card text-card-foreground border border-border rounded-lg p-4 shadow-sm">
          <div>
            <dt className="text-xs text-muted-foreground">UUID</dt>
            <dd className="font-mono text-sm break-all">{record.id}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">时间</dt>
            <dd className="text-sm">{formatHappenedAt(record.happenedAt, tz)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">数值</dt>
            <dd className="text-sm">{record.valueNumber ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">文本</dt>
            <dd className="text-sm whitespace-pre-wrap">{record.valueText ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">标签</dt>
            <dd className="text-sm">{tags.join(', ') || '-'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">客观背景</dt>
            <dd className="text-sm whitespace-pre-wrap">{record.objectiveContext}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">主观解读</dt>
            <dd className="text-sm whitespace-pre-wrap">
              {record.subjectiveInterpretation ?? '-'}
            </dd>
          </div>
        </dl>
      )}
    </div>
  )
}
