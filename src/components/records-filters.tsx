'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { FormEvent, useState } from 'react'
import { TagMultiSelect } from '@/components/tag-multi-select'
import { dayRangeToIso } from '@/lib/datetime-ui'
import { resolveTimezone } from '@/lib/prefs'

type Props = {
  /** 固定附加的 tag（如标签详情页），写入 URL 时保留 */
  lockedTag?: string
  totalCount: number
  page: number
  pageSize: number
}

export function RecordsFilters({
  lockedTag,
  totalCount,
  page,
  pageSize,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [q, setQ] = useState(searchParams.get('q') ?? '')
  const [tags, setTags] = useState(() =>
    searchParams.getAll('tag').filter((t) => t && t !== lockedTag),
  )
  const [day, setDay] = useState(() => {
    // 仅当 URL 无 from/to 时为空；有则不回填复杂 ISO，留给高级用户改 URL
    return ''
  })

  const apply = (e: FormEvent) => {
    e.preventDefault()
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (lockedTag) params.append('tag', lockedTag)
    for (const tag of tags) {
      if (tag && tag !== lockedTag) params.append('tag', tag)
    }
    if (day) {
      const { from, to } = dayRangeToIso(day, resolveTimezone())
      params.set('from', from)
      params.set('to', to)
    } else {
      const from = searchParams.get('from')
      const to = searchParams.get('to')
      if (from) params.set('from', from)
      if (to) params.set('to', to)
    }
    params.set('page', '1')
    if (pageSize !== 20) params.set('pageSize', String(pageSize))
    const base = lockedTag ? `/tags/${encodeURIComponent(lockedTag)}` : '/records'
    router.push(`${base}?${params.toString()}`)
  }

  const goPage = (next: number) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('page', String(next))
    const base = lockedTag ? `/tags/${encodeURIComponent(lockedTag)}` : '/records'
    router.push(`${base}?${params.toString()}`)
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  return (
    <div className="space-y-3 mb-4">
      <form onSubmit={apply} className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">搜索</label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="px-3 py-2 border border-border rounded-lg text-sm bg-input text-foreground"
            placeholder="q"
          />
        </div>
        <TagMultiSelect
          selected={tags}
          lockedTag={lockedTag}
          onChange={setTags}
        />
        <div>
          <label className="block text-xs text-muted-foreground mb-1">
            日期（按时区展开）
          </label>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="px-3 py-2 border border-border rounded-lg text-sm bg-input text-foreground"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary-hover"
        >
          筛选
        </button>
      </form>

      <div className="flex items-center justify-between text-sm text-subtle">
        <span>
          共 {totalCount} 条 · 第 {page}/{totalPages} 页
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => goPage(page - 1)}
            className="px-3 py-1 border border-border rounded bg-card text-foreground disabled:opacity-40"
          >
            上一页
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => goPage(page + 1)}
            className="px-3 py-1 border border-border rounded bg-card text-foreground disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  )
}
