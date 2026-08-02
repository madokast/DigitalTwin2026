/**
 * 轮换本地测试密钥：Neon DB 密码 + 两个 Bearer Token。
 * 只改根目录 `.env.test` 中匹配行；打印旧/新值（中间掩码）。
 *
 * 用法: npm run secrets:rotate-test
 * 之后若需同步 FaaS：npm run deploy -- test
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { maskValue } from './lib/mask'
import { TEST_ENV_FILE } from './lib/test-env'

export { maskValue } from './lib/mask'

const ENV_FILE = TEST_ENV_FILE
const KEYS = ['DATABASE_URL', 'DIGITAL_TWIN_TOKEN', 'DIGITAL_TWIN_ADMIN_TOKEN'] as const

type Key = (typeof KEYS)[number]

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
    throw new Error(`Missing line ${key}=...`)
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
    throw new Error(`Cannot read ${path}`)
  }
}

function parseDatabaseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }
}

function withPassword(url: string, password: string): string {
  const u = parseDatabaseUrl(url)
  u.password = password
  return u.toString()
}

function genDbPassword(): string {
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
  const primary = readEnvFile(ENV_FILE)
  const dbUrlMatch = primary.match(/^DATABASE_URL=(.*)$/m)
  if (!dbUrlMatch) {
    throw new Error('.env.test missing DATABASE_URL')
  }
  const currentDbUrl = unquote(dbUrlMatch[1])
  const parsed = parseDatabaseUrl(currentDbUrl)
  const role = decodeURIComponent(parsed.username)
  if (!role) {
    throw new Error('DATABASE_URL missing username')
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(role)) {
    throw new Error(`Unsafe role name, refusing ALTER: ${role}`)
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

  console.log(`Connecting to test DB and ALTER ROLE ${role} ...`)
  const sql = postgres(currentDbUrl, { max: 1, ssl: 'require' })
  try {
    const escaped = newDbPassword.replace(/'/g, "''")
    await sql.unsafe(`ALTER ROLE ${role} WITH PASSWORD '${escaped}'`)
  } finally {
    await sql.end({ timeout: 5 })
  }

  console.log('Verifying connection with new password ...')
  const verify = postgres(newDbUrl, { max: 1, ssl: 'require' })
  try {
    await verify`select 1 as ok`
  } finally {
    await verify.end({ timeout: 5 })
  }

  const collectedOld: Partial<Record<Key, string>> = {}
  let content = primary
  for (const key of KEYS) {
    const result = replaceEnvLine(content, key, nextValues[key])
    content = result.content
    collectedOld[key] = result.oldValue
  }
  writeFileSync(ENV_FILE, content, 'utf8')
  console.log(`Wrote ${ENV_FILE}`)

  console.log('')
  console.log('Rotated (middle masked):')
  for (const key of KEYS) {
    printChange(key, collectedOld[key]!, nextValues[key])
  }
  console.log('')
  console.log('Next (optional FaaS): npm run deploy -- test')
  console.log('Do NOT: s deploy (prints secrets in plaintext)')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
