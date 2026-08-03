/**
 * 双端 API 集成测：Node (`vitest run tests/api`) + Go (`httpx` / `dbprobe`)。
 * 从根 `.env.test` 注入 DATABASE_URL（及 Token 等）；不打印连接串。
 * 缺失 / 不安全的 DATABASE_URL 则 fail-fast（英文提示）。
 */
import { delimiter, resolve } from 'node:path'
import {
  assertSafeTestDatabaseUrl,
  SAFE_TEST_DATABASE_HINT,
} from '../tests/helpers/db'
import { runInherited } from './lib/spawn'
import { loadTestEnv, REPO_ROOT, TEST_ENV_FILE } from './lib/test-env'

loadTestEnv({ override: true })

const url = process.env.DATABASE_URL?.trim()
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
  ['test', './internal/httpx/', './internal/dbprobe/'],
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
