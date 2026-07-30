'use client'

import { useMemo, useState } from 'react'

type Props = {
  value: string
  onChange: (value: string) => void
}

function listTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

export function TimezoneSelect({ value, onChange }: Props) {
  const [filter, setFilter] = useState('')
  const zones = useMemo(() => listTimeZones(), [])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return zones
    return zones.filter((z) => z.toLowerCase().includes(q))
  }, [filter, zones])

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="搜索时区，如 Shanghai"
        className="w-full px-4 py-2 border border-border rounded-lg bg-input text-foreground placeholder:text-muted-foreground"
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2 border border-border rounded-lg bg-input text-foreground"
        size={8}
      >
        <option value="">跟随浏览器</option>
        {filtered.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
    </div>
  )
}
