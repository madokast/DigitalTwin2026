'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { NullBadge } from '@/components/null-badge'
import { fetchRecordById, type TwinRecord } from '@/lib/api-client'

/**
 * 记录详情页（只读）。
 * 记录编辑 API 已废弃（2026-08-04，410 Gone，见 docs/20260804-log-review.md §5），
 * 本页仅展示；纠错走 export → 修改 → import。
 */
export default function RecordDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [record, setRecord] = useState<TwinRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const row = await fetchRecordById(id)
      if (!row) {
        setError('Record not found')
        setRecord(null)
        return
      }
      setRecord(row)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (cancelled) return
      await load()
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  return (
    <div className="max-w-2xl mx-auto p-4">
      <div className="mb-4">
        <Link href="/records" className="text-sm text-link hover:underline">
          ← Back to Records
        </Link>
      </div>
      <h1 className="text-xl font-bold mb-4 text-foreground">Record Details</h1>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {record && (
        <dl className="space-y-3 bg-card text-card-foreground border border-border rounded-lg p-4 shadow-sm">
          <div>
            <dt className="text-xs text-muted-foreground">UUID</dt>
            <dd className="font-mono text-sm break-all">{record.id}</dd>
          </div>

          <div>
            <dt className="text-xs text-muted-foreground">Time</dt>
            <dd className="font-mono text-sm">{record.happened_at}</dd>
          </div>

          <div>
            <dt className="text-xs text-muted-foreground">Value</dt>
            <dd className="text-sm">
              {record.numeric_value === undefined ? (
                <NullBadge />
              ) : (
                record.numeric_value
              )}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted-foreground">Text</dt>
            <dd className="text-sm whitespace-pre-wrap">
              {record.raw_content === null ? <NullBadge /> : record.raw_content}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted-foreground">Tags</dt>
            <dd>
              {record.tags.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  (no tags)
                </span>
              ) : (
                <div className="flex flex-wrap gap-1.5 text-sm">
                  {record.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center pl-2 pr-2 py-0.5 rounded-md bg-accent text-accent-foreground text-xs font-mono leading-none"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted-foreground">Objective Context</dt>
            <dd className="text-sm whitespace-pre-wrap">
              {record.objective_context}
            </dd>
          </div>

          <div>
            <dt className="text-xs text-muted-foreground">AI Analysis</dt>
            <dd className="text-sm whitespace-pre-wrap">
              {record.ai_analysis === null ? (
                <NullBadge />
              ) : (
                record.ai_analysis
              )}
            </dd>
          </div>
        </dl>
      )}
    </div>
  )
}
