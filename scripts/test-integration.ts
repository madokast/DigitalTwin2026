/**
 * 双端 API 集成测：Node (`vitest run tests/api`) + Go (`httpx` / `dbprobe`)。
 * 从根 `.env.test` 注入 DATABASE_URL（及 Token 等）；不打印连接串。
 * 缺失 / 不安全的 DATABASE_URL 则 fail-fast（英文提示）。
 * 跑测前：可达性检查 → 清库重建表（DROP records / drizzle.__drizzle_migrations → migrate）。
 */
import { delimiter, resolve } from 'node:path'
import postgres from 'postgres'
import {
  assertSafeTestDatabaseUrl,
  migrateTestDatabase,
  SAFE_TEST_DATABASE_HINT,
} from '../tests/helpers/db'
import { runInherited } from './lib/spawn'
import { loadTestEnv, REPO_ROOT, TEST_ENV_FILE } from './lib/test-env'

loadTestEnv({ override: true })

const url = process.env.DATABASE_URL?.trim() ?? ''
if (!url) {
  console.error(
    `DATABASE_URL is required for API integration tests. ${SAFE_TEST_DATABASE_HINT}`,
  )
  console.error(`Set it in ${TEST_ENV_FILE} (copy from .env.test.example if missing).`)
  process.exit(1)
}

try {
  assertSafeTestDatabaseUrl(url)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// tsx 按 CJS 执行：顶层 await 不支持，包 async main
async function main() {
  // 1) 数据库可达性检查
  console.log('Checking test database connectivity...')
  let client: postgres.Sql | null = null
  try {
    client = postgres(url, { max: 1, connect_timeout: 10 })
    await client`SELECT 1`
  } catch (err) {
    console.error(
      `Test database is not reachable: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  // 2) 清库重建表：与基准 migration（drizzle/0000_*.sql）一致，防残留 schema 漂移
  console.log('Rebuilding test database schema (drop records + drizzle migrations, then migrate)...')
  try {
    await client`DROP TABLE IF EXISTS records`
    await client`DROP TABLE IF EXISTS drizzle.__drizzle_migrations`
    await client.end({ timeout: 5 })
    client = null
    await migrateTestDatabase()
  } catch (err) {
    console.error(
      `Test database rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  // 与 vitest setup 一致：业务 notify_user 静音
  process.env.SUPPRESS_BOT_NOTIFICATION ??= '1'

  const binDir = resolve(REPO_ROOT, 'node_modules/.bin')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH ? `${binDir}${delimiter}${process.env.PATH}` : binDir,
  }

  console.log('Running Node API integration tests (vitest run tests/api)...')
  const nodeStatus = runInherited('vitest', ['run', 'tests/api'], {
    cwd: REPO_ROOT,
    env,
  })
  if (nodeStatus !== 0) {
    console.error(`Node integration tests failed (exit ${nodeStatus}).`)
    process.exit(nodeStatus)
  }

  console.log('Running Go API integration tests (./internal/httpx/ ./internal/dbprobe/)...')
  const goStatus = runInherited(
    'go',
    // -count=1：清库重建后必须真跑，禁用 go test 结果缓存（与 CI 一致）
    ['test', '-count=1', './internal/httpx/', './internal/dbprobe/'],
    {
      cwd: resolve(REPO_ROOT, 'faas'),
      env,
    },
  )
  if (goStatus !== 0) {
    console.error(`Go integration tests failed (exit ${goStatus}).`)
    process.exit(goStatus)
  }

  console.log('All API integration tests passed.')
}

main()
