/** 校验 Node/浏览器能否识别的 IANA 时区名 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * 将末尾 ±HHMM 扩成 ±HH:MM；已是 Z/z / ±HH:MM 则原样返回。
 * 与 Go `timeutil.ExpandCompactOffset` 对齐。
 */
export function expandCompactOffset(s: string): string {
  if (s.endsWith('Z') || s.endsWith('z')) return s
  if (/[+-]\d{2}:\d{2}$/.test(s)) return s
  return s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
}

/**
 * 严格 RFC3339 / RFC3339Nano（大写 Z、T 分隔、补零字段）；先 expand ±HHMM。
 * 与 Go `timeutil.ParseRFC3339Flexible` 对齐；失败返回 null。
 */
const RFC3339_STRICT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function parseRFC3339Flexible(raw: string): Date | null {
  const normalized = expandCompactOffset(raw)
  if (!RFC3339_STRICT.test(normalized)) return null
  const d = new Date(normalized)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((p) => p.type === type)?.value
    if (!value) throw new Error(`missing part ${type}`)
    return Number(value)
  }

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** 该瞬间在 timeZone 下的「墙钟」相对 UTC 的偏移（local = utc + offset） */
function offsetMsAt(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - date.getTime()
}

/** 将 timeZone 墙钟时间转为绝对 UTC Date */
export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  let utc = wallAsUtc - offsetMsAt(new Date(wallAsUtc), timeZone)
  // DST 边界再校正一次
  utc = wallAsUtc - offsetMsAt(new Date(utc), timeZone)
  return new Date(utc)
}

/**
 * 返回 now 在指定 IANA 时区下的日历日半开区间 [start, end)（绝对时刻）。
 */
export function getZonedDayBounds(
  now: Date,
  timeZone: string,
): { start: Date; end: Date } {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid time zone: ${timeZone}`)
  }

  const { year, month, day } = zonedParts(now, timeZone)
  return calendarDayBounds(year, month, day, timeZone)
}

/** 指定墙钟日历日在 IANA 时区下的半开区间 [start, end) */
export function calendarDayBounds(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): { start: Date; end: Date } {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid time zone: ${timeZone}`)
  }

  const start = zonedLocalToUtc(year, month, day, 0, 0, 0, timeZone)
  // 与 Go time.Time.AddDate(0,0,1) 同语义：墙钟日历日 +1 的次日 00:00（自然处理 DST 23h/25h 日）
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const end = zonedLocalToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    0,
    timeZone,
  )

  return { start, end }
}
