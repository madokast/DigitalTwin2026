/**
 * 双端单元测（+ 无 DB 契约测）：Node `vitest run --exclude tests/api` + Go `go test -short ./...`。
 * 不加载 .env.test，不需要 DATABASE_URL；与 test-integration.ts 对称。
 */
import { delimiter, resolve } from 'node:path'
import { runInherited } from './lib/spawn'
import { REPO_ROOT } from './lib/test-env'

const binDir = resolve(REPO_ROOT, 'node_modules/.bin')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: process.env.PATH
    ? `${binDir}${delimiter}${process.env.PATH}`
    : binDir,
}

console.log('Running Node unit tests (vitest run --exclude tests/api)...')
const nodeStatus = runInherited('vitest', ['run', '--exclude', 'tests/api/**'], {
  cwd: REPO_ROOT,
  env,
})
if (nodeStatus !== 0) {
  console.error(`Node unit tests failed (exit ${nodeStatus}).`)
  process.exit(nodeStatus)
}

console.log('Running Go unit tests (go test -short ./...)...')
const goStatus = runInherited(
  'go',
  // -count=1：与 CI 一致，禁用 go test 结果缓存，保证命令永远真跑
  ['test', '-short', '-count=1', './...'],
  {
    cwd: resolve(REPO_ROOT, 'faas'),
  },
)
if (goStatus !== 0) {
  console.error(`Go unit tests failed (exit ${goStatus}).`)
  process.exit(goStatus)
}

console.log('All unit tests passed.')
