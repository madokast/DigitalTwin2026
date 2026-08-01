import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for API integration tests (use the dedicated test Neon DB in .env; CI skips this suite when unset)',
    )
  }
  return url
}

/** 独立短连接，用于 migrate / truncate / drop，不与业务单例抢生命周期 */
function adminClient() {
  return postgres(requireDatabaseUrl(), { max: 1 })
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

/**
 * 拆掉业务表与 drizzle 迁移记录，保证下次 migrate 能重新建表。
 * 符合「建表 → 测试 → DROP」约定。
 */
export async function dropTestSchema() {
  const client = adminClient()
  try {
    await client`DROP TABLE IF EXISTS records CASCADE`
    await client`DROP TABLE IF EXISTS "__drizzle_migrations" CASCADE`
    // drizzle-kit / migrator 默认可能写在 drizzle schema
    await client`DROP SCHEMA IF EXISTS drizzle CASCADE`
  } finally {
    await client.end({ timeout: 5 })
  }
}
