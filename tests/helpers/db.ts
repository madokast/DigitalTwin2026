import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

/** 集成测缺失 DATABASE_URL 时的英文提示（Skip / throw 共用）。 */
export const SAFE_TEST_DATABASE_HINT =
  'Point DATABASE_URL at a test database (hostname or database name must contain "test").'

/**
 * 校验测试库 URL：hostname 或数据库名须含 /test/i，或含字面量 TestDigitalTwin。
 * ALLOW_TEST_DB_WIPE=1 不是旁路——仍须通过同一标记校验。
 */
export function assertSafeTestDatabaseUrl(url: string): void {
  const trimmed = url.trim()
  if (!trimmed) {
    throw new Error('DATABASE_URL is empty')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }

  const host = parsed.hostname || ''
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '') || '')
  const looksLikeTest =
    /test/i.test(host) ||
    /test/i.test(dbName) ||
    host.includes('TestDigitalTwin') ||
    dbName.includes('TestDigitalTwin')

  if (!looksLikeTest) {
    throw new Error(
      'Refusing DATABASE_URL: hostname or database name must contain "test" (case-insensitive) or "TestDigitalTwin". ' +
        'Set ALLOW_TEST_DB_WIPE=1 does not bypass this check. ' +
        SAFE_TEST_DATABASE_HINT,
    )
  }
}

/** 只认 DATABASE_URL；缺失则抛错（调用方应先 Skip）。 */
export function resolveTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error(
      `DATABASE_URL is required for API integration tests. ${SAFE_TEST_DATABASE_HINT}`,
    )
  }
  assertSafeTestDatabaseUrl(url)
  return url
}

/** 独立短连接，用于 migrate / truncate，不与业务单例抢生命周期 */
function adminClient() {
  return postgres(resolveTestDatabaseUrl(), { max: 1 })
}

export async function migrateTestDatabase() {
  const client = adminClient()
  try {
    const db = drizzle(client)
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), 'drizzle'),
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}

export async function truncateRecords() {
  const client = adminClient()
  try {
    await client`TRUNCATE TABLE records`
  } finally {
    await client.end({ timeout: 5 })
  }
}
