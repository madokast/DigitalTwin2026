/** 中间掩码；短串整段 * */
export function maskMiddle(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail) {
    return '*'.repeat(Math.max(value.length, 4))
  }
  const stars = Math.min(16, Math.max(6, value.length - head - tail))
  return `${value.slice(0, head)}${'*'.repeat(stars)}${value.slice(-tail)}`
}

/** DATABASE_URL 只掩码 password；其它走 maskMiddle */
export function maskValue(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.password) {
      const user = decodeURIComponent(u.username)
      const pass = maskMiddle(decodeURIComponent(u.password))
      return `${u.protocol}//${user}:${pass}@${u.host}${u.pathname}${u.search}`
    }
  } catch {
    /* not a URL */
  }
  return maskMiddle(raw)
}
