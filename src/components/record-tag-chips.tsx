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
import { isValidTag } from '@/lib/tags'

type Props = {
  tags: string[]
  editing: boolean
  onChange: (tags: string[]) => void
  onRequestEdit: () => void
}

/**
 * 标签始终为独立 chip；编辑态仅显隐 × / +，预留占位避免文字跳动。
 */
export function RecordTagChips({
  tags,
  editing,
  onChange,
  onRequestEdit,
}: Props) {
  const listId = useId()
  const [addOpen, setAddOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [allTags, setAllTags] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // editing 结束 → 复位弹窗 / 过滤（渲染期调整 state，官方推荐模式，避免 effect）
  const [prevEditing, setPrevEditing] = useState(editing)
  if (prevEditing !== editing) {
    setPrevEditing(editing)
    if (!editing) {
      setAddOpen(false)
      setFilter('')
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const map = await fetchTags()
        if (cancelled) return
        setAllTags(map.map((t) => t.tag))
        setLoadError('')
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load tags')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editing])

  useEffect(() => {
    if (!addOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setAddOpen(false)
        setFilter('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [addOpen])

  const taken = useMemo(() => new Set(tags), [tags])

  const options = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return allTags.filter((t) => {
      if (taken.has(t)) return false
      if (!q) return true
      return t.toLowerCase().includes(q)
    })
  }, [allTags, filter, taken])

  const addTag = (tag: string) => {
    if (!tag || taken.has(tag) || !isValidTag(tag)) return
    onChange([...tags, tag])
    setFilter('')
    setAddOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const candidate = filter.trim()
      if (candidate && isValidTag(candidate) && !taken.has(candidate)) {
        addTag(candidate)
        return
      }
      if (options[0]) addTag(options[0])
    }
    if (e.key === 'Escape') {
      setAddOpen(false)
      setFilter('')
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative flex flex-wrap gap-1.5 items-center text-sm"
      onDoubleClick={(e) => {
        e.preventDefault()
        onRequestEdit()
      }}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded-md bg-accent text-accent-foreground text-xs font-mono leading-none"
        >
          <span className="min-w-0">{tag}</span>
          {/* 右侧 × 始终 w-3 占位：只读 invisible，编辑可见；勿用 hidden */}
          <button
            type="button"
            tabIndex={editing ? 0 : -1}
            aria-hidden={!editing}
            aria-label={editing ? `Remove ${tag}` : undefined}
            className={`text-[10px] leading-none w-3 shrink-0 text-center ${
              editing
                ? 'text-link hover:text-accent-foreground'
                : 'invisible pointer-events-none'
            }`}
            onClick={(e) => {
              e.stopPropagation()
              if (!editing) return
              onChange(tags.filter((t) => t !== tag))
            }}
          >
            ×
          </button>
        </span>
      ))}

      <button
        type="button"
        tabIndex={editing ? 0 : -1}
        aria-hidden={!editing}
        aria-label={editing ? 'Add tag' : undefined}
        className={`text-xs font-mono leading-none px-1 py-0.5 rounded-md border border-transparent ${
          editing
            ? 'text-link hover:bg-accent'
            : 'invisible pointer-events-none'
        }`}
        onClick={(e) => {
          e.stopPropagation()
          if (!editing) return
          setAddOpen(true)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
      >
        +
      </button>

      {editing && addOpen && (
        <div className="absolute z-20 left-0 top-full mt-1 w-56 border border-border rounded-lg bg-card text-card-foreground shadow-sm">
          <input
            ref={inputRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            placeholder="Search or press Enter to create…"
            className="w-full px-2 py-1.5 text-xs font-mono outline-none border-b border-border bg-transparent"
          />
          <ul id={listId} role="listbox" className="max-h-40 overflow-auto text-xs">
            {loadError ? (
              <li className="px-2 py-1.5 text-destructive">{loadError}</li>
            ) : options.length === 0 ? (
              <li className="px-2 py-1.5 text-muted-foreground">
                {filter.trim() && isValidTag(filter.trim())
                  ? `Press Enter to create "${filter.trim()}"`
                  : 'No matching tags'}
              </li>
            ) : (
              options.map((tag) => (
                <li key={tag} role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 hover:bg-accent font-mono"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addTag(tag)}
                  >
                    {tag}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
