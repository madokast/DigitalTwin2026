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
        setAllTags(Object.keys(tags).sort())
        setLoadError('')
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : '加载标签失败')
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
      <label className="block text-xs text-gray-500 mb-1">标签</label>
      <div
        className="flex flex-wrap gap-1.5 items-center px-2 py-1.5 border rounded-lg bg-white min-h-[2.5rem] focus-within:ring-1 focus-within:ring-blue-400"
        onClick={() => setOpen(true)}
      >
        {lockedTag && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-gray-700 text-xs font-mono">
            {lockedTag}
          </span>
        )}
        {selected.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 text-xs font-mono"
          >
            {tag}
            <button
              type="button"
              aria-label={`移除 ${tag}`}
              className="text-blue-500 hover:text-blue-800 leading-none"
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
          placeholder={selected.length || lockedTag ? '继续添加…' : '搜索标签…'}
          className="flex-1 min-w-[6rem] outline-none text-sm py-0.5 bg-transparent"
        />
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-48 w-full overflow-auto border rounded-lg bg-white shadow-sm text-sm"
        >
          {loadError ? (
            <li className="px-3 py-2 text-red-600">{loadError}</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-gray-400">无匹配标签</li>
          ) : (
            options.map((tag) => (
              <li key={tag} role="option">
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 hover:bg-blue-50 font-mono text-xs"
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
