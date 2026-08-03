/**
 * 隐列 `utc_offset` 字面量：从带区 ISO 拆后缀并规范化；按隐列格式化瞬间。
 * 与 Go `faas/internal/utcoffset` 对齐；规范见 docs/20260803-utc-offset.md §3。
 */

/** 与 draft / query 一致：Z / ±HH:MM / ±HHMM */
const ISO_TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i

const CANONICAL_OFFSET = /^[+-]\d{2}:\d{2}$/

export type UtcOffsetResult = { ok: true; value: string } | { error: string }

const MISSING_TZ =
  'happened_at must be ISO 8601 with timezone (Z or ±HH:MM)'

/**
 * 从带区 ISO 末尾拆出时区后缀并规范成入库形：`Z` 或 `±HH:MM`。
 * `Z`/`z` → `Z`；`+0800` → `+08:00`；**不**把 `Z` 与 `+00:00` 互相折叠。
 */
export function extractUtcOffsetLiteral(raw: string): UtcOffsetResult {
  if (typeof raw !== 'string' || !raw) {
    return { error: MISSING_TZ }
  }
  const m = ISO_TZ_SUFFIX.exec(raw)
  if (!m) {
    return { error: MISSING_TZ }
  }
  return { ok: true, value: normalizeUtcOffsetSuffix(m[1]) }
}

/** 将已匹配的后缀规范成 `Z` 或 `±HH:MM`。 */
export function normalizeUtcOffsetSuffix(suffix: string): string {
  if (suffix === 'Z' || suffix === 'z') return 'Z'
  if (suffix.length === 5 && suffix[3] !== ':') {
    // ±HHMM
    return `${suffix.slice(0, 3)}:${suffix.slice(3)}`
  }
  return suffix
}

/**
 * 瞬间 + 隐列 `utc_offset` → 带区 ISO（毫秒三位）。
 * `Z` → `…Z`；`+00:00` → `…+00:00`（不折叠）。
 */
export function formatHappenedAt(instant: Date, utcOffset: string): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error('Invalid instant')
  }
  if (utcOffset === 'Z') {
    return formatUtcWall(instant) + 'Z'
  }
  if (!CANONICAL_OFFSET.test(utcOffset)) {
    throw new Error(`Invalid utc_offset: ${utcOffset}`)
  }
  const sign = utcOffset[0] === '-' ? -1 : 1
  const hours = Number(utcOffset.slice(1, 3))
  const minutes = Number(utcOffset.slice(4, 6))
  const offsetMs = sign * (hours * 60 + minutes) * 60_000
  // 用 UTC getter 读「偏移后的墙钟」
  const wall = new Date(instant.getTime() + offsetMs)
  return formatUtcWall(wall) + utcOffset
}

function formatUtcWall(d: Date): string {
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const s = String(d.getUTCSeconds()).padStart(2, '0')
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${ms}`
}
