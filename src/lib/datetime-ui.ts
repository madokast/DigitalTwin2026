import { calendarDayBounds } from '@/lib/time'
import { resolveTimezone } from '@/lib/prefs'

function formatOffsetIso(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''

  const y = get('year')
  const m = get('month')
  const d = get('day')
  const h = get('hour')
  const min = get('minute')
  const s = get('second')
  const rawOffset = get('timeZoneName') // GMT+08:00 / GMT
  let offset = '+00:00'
  if (rawOffset === 'GMT' || rawOffset === 'UTC') {
    offset = '+00:00'
  } else {
    const match = rawOffset.match(/GMT([+-])(\d+)(?::(\d+))?/)
    if (match) {
      offset = `${match[1]}${String(match[2]).padStart(2, '0')}:${String(match[3] ?? '0').padStart(2, '0')}`
    }
  }
  return `${y}-${m}-${d}T${h}:${min}:${s}${offset}`
}

/** 在指定 IANA 时区把「日历日」展开为带偏移 ISO 的半开区间 [day, nextDay) */
export function dayRangeToIso(
  dateYmd: string,
  timeZone?: string,
): { from: string; to: string } {
  const tz = timeZone || resolveTimezone()
  const [y, m, d] = dateYmd.split('-').map(Number)
  if (!y || !m || !d) {
    throw new Error('Invalid date')
  }
  const { start, end } = calendarDayBounds(y, m, d, tz)
  return {
    from: formatOffsetIso(start, tz),
    to: formatOffsetIso(end, tz),
  }
}

/** 格式化详情/表格展示用本地时间字符串 */
export function formatHappenedAt(iso: string, timeZone?: string): string {
  const tz = timeZone || resolveTimezone()
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}
