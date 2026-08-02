/**
 * 用法: npx tsx faas/providers/aliyun-fc/scripts/deploy.ts --env-file <path>
 * 或: ENV_FILE=<path> npm run fc:deploy
 *
 * 不感知 test/prod；无 stdin。从 env 文件读密钥与 FC_FUNCTION_NAME，覆盖 IaC 函数名后部署。
 * 临时 overlay 在 exit 删除。禁止让 `s deploy` 的 stdout/stderr 进终端。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseEnvFileArg,
  usageEnvFile,
} from '../../../../scripts/lib/env-file-arg'
import { parseDotenvFile } from '../../../../scripts/lib/dotenv-file'
import { run, runDiscarded } from '../../../../scripts/lib/spawn'

const PROVIDER_ROOT = resolve(import.meta.dirname, '..')

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'FC_FUNCTION_NAME',
] as const

const OPTIONAL_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'QQBOT_APP_ID',
  'QQBOT_APP_SECRET',
  'QQBOT_USER_OPENID',
] as const

/** 用 FC_FUNCTION_NAME 覆盖 s.yaml 中的 functionName，写临时模板 */
export function patchSyamlFunctionName(
  syaml: string,
  functionName: string,
): string {
  if (!/functionName:\s*\S+/.test(syaml)) {
    throw new Error('s.yaml missing functionName field')
  }
  return syaml.replace(/functionName:\s*\S+/, `functionName: ${functionName}`)
}

function loadSecrets(envFile: string): Record<string, string> {
  if (!existsSync(envFile)) {
    console.error(`missing ${envFile}`)
    process.exit(1)
  }
  const map = parseDotenvFile(envFile)
  const out: Record<string, string> = {}
  for (const key of REQUIRED_KEYS) {
    const v = map[key]?.trim() ?? ''
    if (!v) {
      console.error(`${key} required in ${envFile}`)
      process.exit(1)
    }
    out[key] = map[key]!
  }
  for (const key of OPTIONAL_KEYS) {
    out[key] = map[key] ?? ''
  }
  return out
}

function extractHttpUrl(blob: string): string {
  const m = blob.match(/https:\/\/[^\s]+\.fcapp\.run/g)
  if (!m) return ''
  const publicUrl = m.find((u) => !/vpc/i.test(u))
  return publicUrl ?? m[0] ?? ''
}

async function main(): Promise<void> {
  const envFile = parseEnvFileArg()
  if (!envFile) {
    console.error(usageEnvFile('deploy.ts'))
    process.exit(1)
  }

  const values = loadSecrets(envFile)
  const functionName = values.FC_FUNCTION_NAME.trim()

  for (const [k, v] of Object.entries(values)) {
    process.env[k] = v
  }

  const tmpYaml = resolve(PROVIDER_ROOT, `.s-deploy-overlay.yaml`)
  const cleanup = () => {
    if (existsSync(tmpYaml)) rmSync(tmpYaml, { force: true })
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  const base = readFileSync(resolve(PROVIDER_ROOT, 's.yaml'), 'utf8')
  writeFileSync(tmpYaml, patchSyamlFunctionName(base, functionName), 'utf8')

  console.log(
    `deploying FC function=${functionName} (s deploy output discarded — secrets must not print)`,
  )
  const status = runDiscarded('s', ['deploy', '-t', tmpYaml, '-y'], {
    cwd: PROVIDER_ROOT,
    env: process.env,
  })
  if (status !== 0) {
    console.error(
      `deploy FAILED (function=${functionName}). Re-run only via this script; do not run bare s deploy.`,
    )
    process.exit(1)
  }

  console.log('deploy OK.')
  const scrubbed = {
    ...process.env,
    DATABASE_URL: '',
    DIGITAL_TWIN_TOKEN: '',
    DIGITAL_TWIN_ADMIN_TOKEN: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_USER_ID: '',
    QQBOT_APP_ID: '',
    QQBOT_APP_SECRET: '',
    QQBOT_USER_OPENID: '',
  }
  const info = run('s', ['info', '-t', tmpYaml], {
    cwd: PROVIDER_ROOT,
    env: scrubbed,
  })
  const url = extractHttpUrl(info.stdout + info.stderr)
  if (url) {
    console.log(`HTTP Base URL: ${url}`)
    console.log('Paste into Settings → API Accelerate URL (never commit).')
  } else {
    console.log(
      `Could not parse system_url. Try: cd faas/providers/aliyun-fc && s info -t ${tmpYaml}`,
    )
  }
  console.log('Do NOT run: s deploy   (leaks env secrets to the terminal)')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
