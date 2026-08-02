/**
 * 解析 provider deploy 的 `--env-file <path>` 或环境变量 `ENV_FILE`。
 */
import { resolve } from 'node:path'

export function parseEnvFileArg(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env-file') {
      const next = argv[i + 1]
      if (!next || next.startsWith('-')) return null
      return resolve(next)
    }
    if (a.startsWith('--env-file=')) {
      const v = a.slice('--env-file='.length).trim()
      return v ? resolve(v) : null
    }
  }
  const fromEnv = env.ENV_FILE?.trim()
  return fromEnv ? resolve(fromEnv) : null
}

export function usageEnvFile(scriptHint: string): string {
  return `usage: ${scriptHint} --env-file <path>\n       (or set ENV_FILE=<path>)`
}
