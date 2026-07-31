'use client'

import { useEffect, useState } from 'react'
import { TimezoneSelect } from '@/components/timezone-select'
import {
  getAdminToken,
  getApiAccelerateBase,
  getDashboardSummary,
  getTimezone,
  setAdminToken,
  setApiAccelerateBase,
  setDashboardSummary,
  setTimezone,
} from '@/lib/prefs'

export default function SettingsPage() {
  const [adminToken, setAdminTokenState] = useState('')
  const [summary, setSummaryState] = useState(true)
  const [timezone, setTimezoneState] = useState('')
  const [apiAccelerateBase, setApiAccelerateBaseState] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    setAdminTokenState(getAdminToken())
    setSummaryState(getDashboardSummary())
    setTimezoneState(getTimezone())
    setApiAccelerateBaseState(getApiAccelerateBase())
  }, [])

  const save = () => {
    setAdminToken(adminToken)
    setDashboardSummary(summary)
    setTimezone(timezone)
    setApiAccelerateBase(apiAccelerateBase)
    setMessage('已保存')
  }

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-xl font-bold mb-6 text-foreground">设置</h1>

      <div className="bg-card text-card-foreground p-4 rounded-lg shadow space-y-4 border border-border">
        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            Admin Token
          </label>
          <input
            type="password"
            value={adminToken}
            onChange={(e) => setAdminTokenState(e.target.value)}
            placeholder="DIGITAL_TWIN_ADMIN_TOKEN"
            className="w-full px-4 py-2 border border-border rounded-lg bg-input text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            仅保存在本机浏览器。
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <label className="text-sm font-medium text-foreground">
            Dashboard：显示 summary
          </label>
          <input
            type="checkbox"
            checked={summary}
            onChange={(e) => setSummaryState(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            时区（IANA；空=跟随浏览器）
          </label>
          <TimezoneSelect value={timezone} onChange={setTimezoneState} />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            API 加速地址
          </label>
          <input
            type="url"
            value={apiAccelerateBase}
            onChange={(e) => setApiAccelerateBaseState(e.target.value)}
            placeholder="空=同源 Vercel；例 https://xxx.region.fcapp.run"
            className="w-full px-4 py-2 border border-border rounded-lg bg-input text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            仅保存在本机浏览器。空则走同源 `/api/...`；非空则用该 origin 拼接（勿把真实地址写进仓库）。
          </p>
        </div>

        <button
          type="button"
          onClick={save}
          className="w-full px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary-hover"
        >
          保存
        </button>

        {message && <p className="text-sm text-success">{message}</p>}
      </div>
    </div>
  )
}
