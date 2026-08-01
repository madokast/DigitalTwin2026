'use client'

import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { NullBadge } from '@/components/null-badge'
import { RecordTagChips } from '@/components/record-tag-chips'
import {
  fetchRecordById,
  patchRecord,
  type TwinRecord,
} from '@/lib/api-client'
import {
  formatHappenedAt,
  isoToDatetimeLocalValue,
  wallDateTimeToOffsetIso,
} from '@/lib/datetime-ui'
import { getAdminToken, resolveTimezone } from '@/lib/prefs'
import { parseRecordDraft } from '@/lib/draft'

type FieldKey =
  | 'happenedAt'
  | 'valueNumber'
  | 'valueText'
  | 'tags'
  | 'objectiveContext'
  | 'subjectiveInterpretation'

type Draft = {
  happenedLocal: string
  valueNumber: string
  valueText: string | null
  tags: string[]
  objectiveContext: string
  subjectiveInterpretation: string | null
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    return []
  }
}

function recordToDraft(record: TwinRecord, tz: string): Draft {
  return {
    happenedLocal: isoToDatetimeLocalValue(record.happenedAt, tz),
    valueNumber: record.valueNumber ?? '',
    valueText: record.valueText,
    tags: parseTags(record.tags),
    objectiveContext: record.objectiveContext,
    subjectiveInterpretation: record.subjectiveInterpretation,
  }
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return (
    a.happenedLocal === b.happenedLocal &&
    a.valueNumber === b.valueNumber &&
    a.valueText === b.valueText &&
    a.objectiveContext === b.objectiveContext &&
    a.subjectiveInterpretation === b.subjectiveInterpretation &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  )
}

function placeCaretAtEnd(el: HTMLElement) {
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

function NullableText({
  value,
  editing,
  multiline,
  onChange,
  onRequestEdit,
}: {
  value: string | null
  editing: boolean
  multiline?: boolean
  onChange: (next: string | null) => void
  onRequestEdit: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const enteredRef = useRef(false)

  useEffect(() => {
    if (!editing) {
      enteredRef.current = false
      return
    }
    const el = ref.current
    if (!el || enteredRef.current) return
    enteredRef.current = true
    el.textContent = value ?? ''
    placeCaretAtEnd(el)
  }, [editing, value])

  if (!editing) {
    return (
      <span
        className={`text-sm block min-h-[1.25rem] ${multiline ? 'whitespace-pre-wrap' : ''}`}
        onDoubleClick={(e) => {
          e.preventDefault()
          onRequestEdit()
        }}
      >
        {value === null ? <NullBadge /> : value}
      </span>
    )
  }

  return (
    <span
      ref={ref}
      role="textbox"
      contentEditable
      suppressContentEditableWarning
      className={`text-sm block min-h-[1.25rem] outline-none ${
        multiline ? 'whitespace-pre-wrap' : ''
      }`}
      onInput={() => {
        const text = ref.current?.textContent ?? ''
        onChange(text === '' ? null : text)
      }}
    />
  )
}

function RequiredText({
  value,
  editing,
  multiline,
  onChange,
  onRequestEdit,
}: {
  value: string
  editing: boolean
  multiline?: boolean
  onChange: (next: string) => void
  onRequestEdit: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const enteredRef = useRef(false)

  useEffect(() => {
    if (!editing) {
      enteredRef.current = false
      return
    }
    const el = ref.current
    if (!el || enteredRef.current) return
    enteredRef.current = true
    el.textContent = value
    placeCaretAtEnd(el)
  }, [editing, value])

  if (!editing) {
    return (
      <span
        className={`text-sm block min-h-[1.25rem] ${multiline ? 'whitespace-pre-wrap' : ''}`}
        onDoubleClick={(e) => {
          e.preventDefault()
          onRequestEdit()
        }}
      >
        {value}
      </span>
    )
  }

  return (
    <span
      ref={ref}
      role="textbox"
      contentEditable
      suppressContentEditableWarning
      className={`text-sm block min-h-[1.25rem] outline-none ${
        multiline ? 'whitespace-pre-wrap' : ''
      }`}
      onInput={() => {
        onChange(ref.current?.textContent ?? '')
      }}
    />
  )
}

export default function RecordDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [record, setRecord] = useState<TwinRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [baseline, setBaseline] = useState<Draft | null>(null)
  const [editing, setEditing] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [permHint, setPermHint] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const numberRef = useRef<HTMLInputElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)

  const tz = typeof window !== 'undefined' ? resolveTimezone() : 'UTC'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const row = await fetchRecordById(id)
      if (!row) {
        setError('Record not found')
        setRecord(null)
        setDraft(null)
        setBaseline(null)
        return
      }
      const next = recordToDraft(row, resolveTimezone())
      setRecord(row)
      setDraft(next)
      setBaseline(next)
      setEditing({})
      setSubmitError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (cancelled) return
      await load()
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const requestEdit = (field: FieldKey) => {
    if (!getAdminToken()) {
      setPermHint('No edit permission')
      return
    }
    setPermHint('')
    setEditing((prev) => ({ ...prev, [field]: true }))
  }

  const dirty =
    draft !== null && baseline !== null && !draftsEqual(draft, baseline)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft || !dirty || submitting) return
    setSubmitError('')
    setSubmitting(true)
    try {
      let happenedAt: string
      try {
        happenedAt = wallDateTimeToOffsetIso(draft.happenedLocal, resolveTimezone())
      } catch {
        setSubmitError('Invalid datetime format')
        return
      }

      const body = {
        happened_at: happenedAt,
        value_number: draft.valueNumber === '' ? null : draft.valueNumber,
        value_text: draft.valueText,
        tags: draft.tags,
        objective_context: draft.objectiveContext,
        subjective_interpretation: draft.subjectiveInterpretation,
      }
      const parsed = parseRecordDraft(body)
      if ('error' in parsed) {
        setSubmitError(parsed.error)
        return
      }

      await patchRecord(id, body)
      await load()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!editing.valueNumber || !numberRef.current) return
    const el = numberRef.current
    el.focus()
    el.select()
  }, [editing.valueNumber])

  useEffect(() => {
    if (!editing.happenedAt || !timeInputRef.current) return
    const el = timeInputRef.current
    el.focus()
    try {
      el.showPicker?.()
    } catch {
      // 某些环境不支持 showPicker
    }
  }, [editing.happenedAt])

  return (
    <div className="max-w-2xl mx-auto p-4">
      <div className="mb-4">
        <Link href="/records" className="text-sm text-link hover:underline">
          ← Back to Records
        </Link>
      </div>
      <h1 className="text-xl font-bold mb-4 text-foreground">Record Details</h1>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {permHint && (
        <p className="text-sm text-destructive mb-2" role="status">
          {permHint}
        </p>
      )}

      {record && draft && (
        <form onSubmit={onSubmit}>
          <dl className="space-y-3 bg-card text-card-foreground border border-border rounded-lg p-4 shadow-sm">
            <div>
              <dt className="text-xs text-muted-foreground">UUID</dt>
              <dd className="font-mono text-sm break-all">{record.id}</dd>
            </div>

            <div>
              <dt className="text-xs text-muted-foreground">Time</dt>
              <dd className="relative text-sm min-h-[1.25rem]">
                <span
                  className={
                    editing.happenedAt
                      ? 'invisible pointer-events-none'
                      : 'block'
                  }
                  aria-hidden={!!editing.happenedAt}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    requestEdit('happenedAt')
                  }}
                >
                  {(() => {
                    try {
                      return formatHappenedAt(
                        wallDateTimeToOffsetIso(draft.happenedLocal, tz),
                        tz,
                      )
                    } catch {
                      return formatHappenedAt(record.happenedAt, tz)
                    }
                  })()}
                </span>
                {editing.happenedAt && (
                  <input
                    ref={timeInputRef}
                    type="datetime-local"
                    value={draft.happenedLocal}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, happenedLocal: e.target.value } : d,
                      )
                    }
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    aria-label="Select time"
                  />
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs text-muted-foreground">Value</dt>
              <dd className="text-sm min-h-[1.25rem]">
                {editing.valueNumber ? (
                  <input
                    ref={numberRef}
                    type="text"
                    inputMode="decimal"
                    value={draft.valueNumber}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, valueNumber: e.target.value } : d,
                      )
                    }
                    className="w-full text-sm bg-transparent border-0 p-0 m-0 outline-none"
                  />
                ) : (
                  <span
                    className="block"
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      requestEdit('valueNumber')
                    }}
                  >
                    {record.valueNumber === null ? (
                      <NullBadge />
                    ) : (
                      record.valueNumber
                    )}
                  </span>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs text-muted-foreground">Text</dt>
              <dd>
                <NullableText
                  value={draft.valueText}
                  editing={!!editing.valueText}
                  multiline
                  onRequestEdit={() => requestEdit('valueText')}
                  onChange={(next) =>
                    setDraft((d) => (d ? { ...d, valueText: next } : d))
                  }
                />
              </dd>
            </div>

            <div>
              <dt className="text-xs text-muted-foreground">Tags</dt>
              <dd>
                <RecordTagChips
                  tags={draft.tags}
                  editing={!!editing.tags}
                  onRequestEdit={() => requestEdit('tags')}
                  onChange={(tags) =>
                    setDraft((d) => (d ? { ...d, tags } : d))
                  }
                />
              </dd>
            </div>

            <div>
              <dt className="text-xs text-muted-foreground">Objective Context</dt>
              <dd>
                <RequiredText
                  value={draft.objectiveContext}
                  editing={!!editing.objectiveContext}
                  multiline
                  onRequestEdit={() => requestEdit('objectiveContext')}
                  onChange={(next) =>
                    setDraft((d) =>
                      d ? { ...d, objectiveContext: next } : d,
                    )
                  }
                />
              </dd>
            </div>

            <div>
              <dt className="text-xs text-muted-foreground">Subjective Interpretation</dt>
              <dd>
                <NullableText
                  value={draft.subjectiveInterpretation}
                  editing={!!editing.subjectiveInterpretation}
                  multiline
                  onRequestEdit={() =>
                    requestEdit('subjectiveInterpretation')
                  }
                  onChange={(next) =>
                    setDraft((d) =>
                      d ? { ...d, subjectiveInterpretation: next } : d,
                    )
                  }
                />
              </dd>
            </div>
          </dl>

          {submitError && (
            <p className="mt-3 text-sm text-destructive">{submitError}</p>
          )}

          {dirty && (
            <div className="mt-4">
              <button
                type="submit"
                disabled={submitting}
                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  )
}
