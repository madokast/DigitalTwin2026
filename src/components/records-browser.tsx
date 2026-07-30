'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { RecordsFilters } from '@/components/records-filters'
import { RecordsTable } from '@/components/records-table'
import { fetchRecords, type TwinRecord } from '@/lib/api-client'

function RecordsPageInner({ lockedTag }: { lockedTag?: string }) {
  const searchParams = useSearchParams()
  const [records, setRecords] = useState<TwinRecord[]>([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const queryKey = searchParams.toString()

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams(searchParams.toString())
        if (lockedTag && !params.getAll('tag').includes(lockedTag)) {
          params.append('tag', lockedTag)
        }
        const data = await fetchRecords(params.toString())
        if (cancelled) return
        setRecords(data.records)
        setCount(data.count)
        setPage(data.page)
        setPageSize(data.pageSize)
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
  }, [queryKey, lockedTag, searchParams])

  return (
    <div className="max-w-6xl mx-auto p-4">
      <h1 className="text-xl font-bold mb-4">
        {lockedTag ? `标签：${lockedTag}` : '记录'}
      </h1>

      <RecordsFilters
        lockedTag={lockedTag}
        totalCount={count}
        page={page}
        pageSize={pageSize}
      />

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">加载中…</p>
      ) : (
        <RecordsTable records={records} />
      )}
    </div>
  )
}

export function RecordsBrowser({ lockedTag }: { lockedTag?: string }) {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-gray-500">加载中…</p>}>
      <RecordsPageInner lockedTag={lockedTag} />
    </Suspense>
  )
}
