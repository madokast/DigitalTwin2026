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
function zonedLocalToUtc(
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
  const start = zonedLocalToUtc(year, month, day, 0, 0, 0, timeZone)

  // 次日 00:00：用 start + 25h 再取该区日历日，避免夏令时少一小时踩坑
  const probe = new Date(start.getTime() + 25 * 60 * 60 * 1000)
  const next = zonedParts(probe, timeZone)
  // 若 probe 仍落在同一天（极罕见），再加一天
  let endDay = { year: next.year, month: next.month, day: next.day }
  if (endDay.year === year && endDay.month === month && endDay.day === day) {
    const later = new Date(start.getTime() + 36 * 60 * 60 * 1000)
    const p2 = zonedParts(later, timeZone)
    endDay = { year: p2.year, month: p2.month, day: p2.day }
  }
  const end = zonedLocalToUtc(endDay.year, endDay.month, endDay.day, 0, 0, 0, timeZone)

  return { start, end }
}
