'use client'

import {
  KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { fetchTags } from '@/lib/api-client'

type Props = {
  selected: string[]
  lockedTag?: string
  onChange: (tags: string[]) => void
}

export function TagMultiSelect({ selected, lockedTag, onChange }: Props) {
  const listId = useId()
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(false)
  const [allTags, setAllTags] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const tags = await fetchTags()
        if (cancelled) return
        setAllTags(tags.map((t) => t.tag))
        setLoadError('')
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load tags')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const taken = useMemo(() => {
    const set = new Set(selected)
    if (lockedTag) set.add(lockedTag)
    return set
  }, [selected, lockedTag])

  const options = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return allTags.filter((t) => {
      if (taken.has(t)) return false
      if (!q) return true
      return t.toLowerCase().includes(q)
    })
  }, [allTags, filter, taken])

  const addTag = (tag: string) => {
    if (taken.has(tag)) return
    onChange([...selected, tag])
    setFilter('')
    setOpen(true)
  }

  const removeTag = (tag: string) => {
    onChange(selected.filter((t) => t !== tag))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && filter === '' && selected.length > 0) {
      e.preventDefault()
      onChange(selected.slice(0, -1))
      return
    }
    if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative min-w-[14rem]">
      <label className="block text-xs text-muted-foreground mb-1">Tags</label>
      <div
        className="flex flex-wrap gap-1.5 items-center px-2 py-1.5 border border-border rounded-lg bg-input text-foreground min-h-[2.5rem] focus-within:ring-1 focus-within:ring-ring"
        onClick={() => setOpen(true)}
      >
        {lockedTag && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted text-foreground text-xs font-mono">
            {lockedTag}
          </span>
        )}
        {selected.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent text-accent-foreground text-xs font-mono"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              className="text-link hover:text-accent-foreground leading-none"
              onClick={(e) => {
                e.stopPropagation()
                removeTag(tag)
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="search"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder={selected.length || lockedTag ? 'Continue adding…' : 'Search tags…'}
          className="flex-1 min-w-[6rem] outline-none text-sm py-0.5 bg-transparent text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-48 w-full overflow-auto border border-border rounded-lg bg-card text-card-foreground shadow-sm text-sm"
        >
          {loadError ? (
            <li className="px-3 py-2 text-destructive">{loadError}</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">No matching tags</li>
          ) : (
            options.map((tag) => (
              <li key={tag} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 hover:bg-accent hover:text-accent-foreground font-mono text-xs"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addTag(tag)}
                >
                  {tag}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
