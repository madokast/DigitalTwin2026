'use client'

import { useRouter } from 'next/navigation'
import type { TwinRecord } from '@/lib/api-client'
import { formatHappenedAt } from '@/lib/datetime-ui'
import { resolveTimezone } from '@/lib/prefs'

type Props = {
  records: TwinRecord[]
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function RecordsTable({ records }: Props) {
  const router = useRouter()
  const tz = typeof window !== 'undefined' ? resolveTimezone() : 'UTC'

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto border border-gray-100">
      <table className="w-full min-w-[720px]">
        <thead className="bg-gray-100">
          <tr>
            <th className="px-3 py-2 text-left text-sm">时间</th>
            <th className="px-3 py-2 text-left text-sm">数值</th>
            <th className="px-3 py-2 text-left text-sm">文本</th>
            <th className="px-3 py-2 text-left text-sm">标签</th>
            <th className="px-3 py-2 text-left text-sm">客观背景</th>
            <th className="px-3 py-2 text-left text-sm">主观解读</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={record.id}
              className="border-t hover:bg-gray-50 cursor-pointer"
              onClick={() => router.push(`/records/${record.id}`)}
            >
              <td className="px-3 py-2 text-xs whitespace-nowrap">
                {formatHappenedAt(record.happenedAt, tz)}
              </td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">
                {record.valueNumber || '-'}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.valueText || '-'}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {parseTags(record.tags).join(', ') || '-'}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.objectiveContext}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.subjectiveInterpretation || '-'}
              </td>
            </tr>
          ))}
          {records.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-sm text-gray-500">
                暂无记录
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
