import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function unquote(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      /* fall through */
    }
  }
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1)
  }
  return t
}

function quoteEnv(value: string): string {
  return JSON.stringify(value)
}

/** 读 dotenv 单键；无文件/无键 → "" */
export function readDotenvKey(filePath: string, key: string): string {
  if (!existsSync(filePath)) return ''
  const content = readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    if (k !== key) continue
    return unquote(t.slice(eq + 1))
  }
  return ''
}

/** 解析整文件为 Record（后者覆盖前者） */
export function parseDotenvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(filePath)) return out
  const content = readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    out[k] = unquote(t.slice(eq + 1))
  }
  return out
}

/**
 * 更新或追加 KEY=value（JSON 双引号）。
 * 不打印 value。
 */
export function upsertDotenvKey(
  filePath: string,
  key: string,
  value: string,
): void {
  const line = `${key}=${quoteEnv(value)}`
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${line}\n`, { mode: 0o600 })
    return
  }
  const content = readFileSync(filePath, 'utf8')
  const lines = content.split(/\r?\n/)
  let done = false
  const next = lines.map((row) => {
    if (row.startsWith(`${key}=`)) {
      done = true
      return line
    }
    return row
  })
  if (!done) {
    if (next.length && next[next.length - 1] === '') {
      next[next.length - 1] = line
      next.push('')
    } else {
      next.push(line)
    }
  }
  writeFileSync(filePath, next.join('\n'), { mode: 0o600 })
}

/** 写完整 fc env 文件 */
export function writeFcEnvFile(
  filePath: string,
  values: Record<string, string>,
): void {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${quoteEnv(v)}`)
    .join('\n')
  writeFileSync(filePath, `${body}\n`, { mode: 0o600 })
}
