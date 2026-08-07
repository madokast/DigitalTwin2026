'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { FormEvent, useState } from 'react'
import { RecordsBrowser } from '@/components/records-browser'
import { normalizeTags } from '@/lib/api-client'

export default function TagDetailPage() {
  const params = useParams<{ tag: string }>()
  const router = useRouter()
  const tag = decodeURIComponent(params.tag)
  const [fromInput, setFromInput] = useState(tag)
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onNormalize = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const from = fromInput.split(',').map((s) => s.trim()).filter(Boolean)
      const updated = await normalizeTags(from, to.trim())
      setMessage(`Updated ${updated} record(s)`)
      router.replace(`/tags/${encodeURIComponent(to.trim())}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Normalize failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="max-w-6xl mx-auto px-4 pt-4">
        <Link href="/tags" className="text-sm text-link hover:underline">
          ← Back to Tags
        </Link>

        <form
          onSubmit={onNormalize}
          className="mt-4 bg-card text-card-foreground border border-border rounded-lg p-4 shadow-sm space-y-3 max-w-md"
        >
          <h2 className="font-medium">Normalize tags globally (Admin Token required)</h2>
          <p className="text-sm text-subtle">
            Tags to merge (comma-separated), all become:
          </p>
          <input
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            placeholder="e.g. exercise, workout"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-input text-foreground placeholder:text-muted-foreground"
          />
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Canonical tag name"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-input text-foreground placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={loading || !to.trim() || !fromInput.trim()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary-hover disabled:bg-disabled disabled:text-primary-foreground"
          >
            {loading ? 'Processing…' : 'Normalize'}
          </button>
          {message && <p className="text-sm text-success">{message}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </div>

      <RecordsBrowser lockedTag={tag} />
    </div>
  )
}
