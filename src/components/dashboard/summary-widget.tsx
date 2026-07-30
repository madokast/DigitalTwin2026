'use client'

import { useEffect, useState } from 'react'
import { fetchSummary } from '@/lib/api-client'
import { resolveTimezone } from '@/lib/prefs'

export function SummaryWidget() {
  const [total, setTotal] = useState<number | null>(null)
  const [today, setToday] = useState<number | null>(null)
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

  if (loading) {
    return <p className="text-sm text-gray-500">加载 summary…</p>
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>
  }

  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold">概览</h2>
      <p className="text-sm text-gray-600">时区：{tz}</p>
      <div className="flex gap-8">
        <div>
          <div className="text-3xl font-bold tabular-nums">{total}</div>
          <div className="text-sm text-gray-500">全部记录</div>
        </div>
        <div>
          <div className="text-3xl font-bold tabular-nums">{today}</div>
          <div className="text-sm text-gray-500">今日新增</div>
        </div>
      </div>
    </div>
  )
}
