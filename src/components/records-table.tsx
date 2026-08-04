'use client'

import { useRouter } from 'next/navigation'
import type { TwinRecord } from '@/lib/api-client'
import { formatHappenedAt } from '@/lib/datetime-ui'
import { resolveTimezone } from '@/lib/prefs'

type Props = {
  records: TwinRecord[]
}

export function RecordsTable({ records }: Props) {
  const router = useRouter()
  const tz = typeof window !== 'undefined' ? resolveTimezone() : 'UTC'

  return (
    <div className="bg-card text-card-foreground rounded-lg shadow overflow-x-auto border border-border">
      <table className="w-full min-w-[720px]">
        <thead className="bg-muted text-foreground">
          <tr>
            <th className="px-3 py-2 text-left text-sm">Time</th>
            <th className="px-3 py-2 text-left text-sm">Value</th>
            <th className="px-3 py-2 text-left text-sm">Text</th>
            <th className="px-3 py-2 text-left text-sm">Tags</th>
            <th className="px-3 py-2 text-left text-sm">Objective Context</th>
            <th className="px-3 py-2 text-left text-sm">AI Analysis</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={record.id}
              className="border-t border-border hover:bg-muted/60 cursor-pointer"
              onClick={() => router.push(`/records/${record.id}`)}
            >
              <td className="px-3 py-2 text-xs whitespace-nowrap">
                {formatHappenedAt(record.happened_at, tz)}
              </td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">
                {record.numeric_value || '-'}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.raw_content || '-'}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.tags.join(', ') || '-'}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.objective_context}
              </td>
              <td className="px-3 py-2 text-xs max-w-[160px] truncate whitespace-nowrap">
                {record.ai_analysis || '-'}
              </td>
            </tr>
          ))}
          {records.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="px-3 py-6 text-center text-sm text-muted-foreground"
              >
                No records yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
