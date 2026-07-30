'use client'

import { useEffect, useState } from 'react'
import { fetchSummary } from '@/lib/api-client'
import { resolveTimezone } from '@/lib/prefs'

export function SummaryWidget() {
  const [total, setTotal] = useState(0)
  const [today, setToday] = useState(0)
  const [tz, setTz] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const zone = resolveTimezone()
        const data = await fetchSummary(zone)
        if (cancelled) return
        setTotal(data.total)
        setToday(data.today)
        setTz(data.tz)
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

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>
  }

  return (
    <div className="flex items-baseline gap-4 overflow-x-auto whitespace-nowrap text-sm">
      <h2 className="text-lg font-semibold text-card-foreground shrink-0">
        {loading ? '加载中' : '概览'}
      </h2>
      <span className="text-subtle shrink-0">时区：{tz || '—'}</span>
      <span className="tabular-nums text-card-foreground shrink-0">
        <span className="text-lg font-bold">{total}</span>
        <span className="ml-1 text-muted-foreground">全部记录</span>
      </span>
      <span className="tabular-nums text-card-foreground shrink-0">
        <span className="text-lg font-bold">{today}</span>
        <span className="ml-1 text-muted-foreground">今日新增</span>
      </span>
    </div>
  )
}
