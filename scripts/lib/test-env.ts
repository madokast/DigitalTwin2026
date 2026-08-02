/**
 * 本地 / 测试统一加载根目录 `.env.test`（废除根 `.env`）。
 */
import { resolve } from 'node:path'
import { config } from 'dotenv'

/** 仓库根（scripts/lib → ../..） */
export const REPO_ROOT = resolve(import.meta.dirname, '../..')

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
