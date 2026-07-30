'use client'

import { useEffect, useState } from 'react'
import { SummaryWidget } from '@/components/dashboard/summary-widget'
import { getDashboardSummary } from '@/lib/prefs'

export default function DashboardPage() {
  const [showSummary, setShowSummary] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setShowSummary(getDashboardSummary())
    setReady(true)
  }, [])

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      {!ready ? null : showSummary ? (
        <div className="bg-white border border-gray-100 rounded-lg p-6 shadow-sm">
          <SummaryWidget />
        </div>
      ) : (
        <p className="text-sm text-gray-500">
          Summary 已在设置中关闭，不会请求数据。
        </p>
      )}
    </div>
  )
}
