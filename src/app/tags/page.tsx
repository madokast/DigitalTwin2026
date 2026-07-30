'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { fetchTags } from '@/lib/api-client'

export default function TagsPage() {
  const [tags, setTags] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const data = await fetchTags()
        if (cancelled) return
        setTags(data)
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
  }, [])

  const entries = Object.entries(tags)

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-xl font-bold mb-6 text-foreground">标签</h1>

      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {error && <p className="text-sm text-destructive mb-3">{error}</p>}

      {!loading && !error && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无标签</p>
      )}

      <ul className="space-y-1">
        {entries.map(([tag, count]) => (
          <li key={tag}>
            <Link
              href={`/tags/${encodeURIComponent(tag)}`}
              className="flex justify-between px-3 py-2 rounded-lg hover:bg-muted font-mono text-sm text-foreground"
            >
              <span>{tag}</span>
              <span className="text-muted-foreground">{count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
