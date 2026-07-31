/**
 * 轮换本地测试密钥：Neon DB 密码 + 两个 Bearer Token。
 * 只改 .env 与 fc/.env.fc.test 中匹配行；打印旧/新值（中间掩码）。
 *
 * 用法: npm run secrets:rotate-test
 * 之后需: cd fc && ./scripts/deploy.sh test（禁止裸跑 s deploy）
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const ROOT = resolve(import.meta.dirname, '..')
const ENV_FILES = [resolve(ROOT, '.env'), resolve(ROOT, 'fc/.env.fc.test')]
const KEYS = ['DATABASE_URL', 'DIGITAL_TWIN_TOKEN', 'DIGITAL_TWIN_ADMIN_TOKEN'] as const

type Key = (typeof KEYS)[number]

function maskMiddle(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail) {
    return '*'.repeat(Math.max(value.length, 4))
  }
  const stars = Math.min(16, Math.max(6, value.length - head - tail))
  return `${value.slice(0, head)}${'*'.repeat(stars)}${value.slice(-tail)}`
}

/** DATABASE_URL 只掩码 password 段，便于看出 host 未变、密码已换 */
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

function unquote(raw: string): string {
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function quoteLike(oldRaw: string, value: string): string {
  if (oldRaw.startsWith("'") && oldRaw.endsWith("'")) {
    return `'${value}'`
  }
  if (oldRaw.startsWith('"') && oldRaw.endsWith('"')) {
    return `"${value}"`
  }
  return value
}

/** 仅替换匹配 KEY= 行；其它行不动。缺行则抛错。 */
export function replaceEnvLine(
  content: string,
  key: string,
  newValue: string,
): { content: string; oldValue: string; oldRaw: string } {
  const re = new RegExp(`^(${key})=(.*)$`, 'm')
  const m = content.match(re)
  if (!m) {
    throw new Error(`缺少行 ${key}=...`)
  }
  const oldRaw = m[2]
  const oldValue = unquote(oldRaw)
  const newRaw = quoteLike(oldRaw, newValue)
  return {
    content: content.replace(re, `${key}=${newRaw}`),
    oldValue,
    oldRaw,
  }
}

function readEnvFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error(`无法读取 ${path}`)
  }
}

function parseDatabaseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new Error('DATABASE_URL 不是合法 URL')
  }
}

function withPassword(url: string, password: string): string {
  const u = parseDatabaseUrl(url)
  u.password = password
  return u.toString()
}

function genDbPassword(): string {
  // URL 安全 Base64，去 padding，减少 .env / URI 转义
  return randomBytes(32).toString('base64url')
}

function genToken(prefix: 'dt' | 'adm'): string {
  return `${prefix}-${randomBytes(32).toString('hex')}`
}

function printChange(key: Key, oldValue: string, newValue: string) {
  console.log(`${key}`)
  console.log(`  old: ${maskValue(oldValue)}`)
  console.log(`  new: ${maskValue(newValue)}`)
}

async function main() {
  const primary = readEnvFile(ENV_FILES[0])
  const dbUrlMatch = primary.match(/^DATABASE_URL=(.*)$/m)
  if (!dbUrlMatch) {
    throw new Error('.env 缺少 DATABASE_URL')
  }
  const currentDbUrl = unquote(dbUrlMatch[1])
  const parsed = parseDatabaseUrl(currentDbUrl)
  const role = decodeURIComponent(parsed.username)
  if (!role) {
    throw new Error('DATABASE_URL 缺少用户名')
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
    throw new Error(`角色名不安全，拒绝 ALTER: ${role}`)
  }

  const newDbPassword = genDbPassword()
  const newDbUrl = withPassword(currentDbUrl, newDbPassword)
  const newAiToken = genToken('dt')
  const newAdminToken = genToken('adm')

  const nextValues: Record<Key, string> = {
    DATABASE_URL: newDbUrl,
    DIGITAL_TWIN_TOKEN: newAiToken,
    DIGITAL_TWIN_ADMIN_TOKEN: newAdminToken,
  }

  console.log(`连接测试库并 ALTER ROLE ${role} ...`)
  const sql = postgres(currentDbUrl, { max: 1, ssl: 'require' })
  try {
    const escaped = newDbPassword.replace(/'/g, "''")
    await sql.unsafe(`ALTER ROLE ${role} WITH PASSWORD '${escaped}'`)
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log('用新密码校验连接 ...')
  const verify = postgres(newDbUrl, { max: 1, ssl: 'require' })
  try {
    await verify`select 1 as ok`
  } finally {
    await verify.end({ timeout: 5 })
  }

  const collectedOld: Partial<Record<Key, string>> = {}

  for (const file of ENV_FILES) {
    let content = readEnvFile(file)
    for (const key of KEYS) {
      const result = replaceEnvLine(content, key, nextValues[key])
      content = result.content
      if (!(key in collectedOld)) {
        collectedOld[key] = result.oldValue
      } else if (collectedOld[key] !== result.oldValue) {
        console.warn(`警告: ${file} 的 ${key} 与 .env 不一致（仍已替换）`)
      }
    }
    writeFileSync(file, content, 'utf8')
    console.log(`已写入 ${file}`)
  }

  console.log('')
  console.log('已轮换（中间已掩码）：')
  for (const key of KEYS) {
    printChange(key, collectedOld[key]!, nextValues[key])
  }
  console.log('')
  console.log('下一步: cd fc && ./scripts/deploy.sh test')
  console.log('禁止: s deploy（会明文打印密钥）')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
