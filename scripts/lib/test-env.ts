/**
 * 本地 / 测试统一加载根目录 `.env.test`（废除根 `.env`）。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/**
 * 仓库根（scripts/lib → ../..）。
 * 不用 import.meta.dirname：Next/Turbopack 打包后常为 undefined，
 * path.resolve(undefined, …) 会在 collect page data 阶段直接抛错。
 */
function resolveRepoRoot(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  } catch {
    return process.cwd()
  }
}

export const REPO_ROOT = resolveRepoRoot()

export const TEST_ENV_FILE = resolve(REPO_ROOT, '.env.test')
export const PROD_ENV_FILE = resolve(REPO_ROOT, '.env.prod')

/** 显式加载 `.env.test`；默认 override 避免 shell 残留覆盖文件 */
export function loadTestEnv(options?: { override?: boolean }): void {
  config({
    path: TEST_ENV_FILE,
    override: options?.override ?? true,
    quiet: true,
  })
}
