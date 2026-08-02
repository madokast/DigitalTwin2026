/**
 * 用法: npx tsx faas/providers/tencent-scf/scripts/deploy.ts --env-file <path>
 * 或: ENV_FILE=<path> npm run scf:deploy
 *
 * 不感知 test/prod；无 stdin。从 env 文件读密钥与 SCF_FUNCTION_NAME。
 * 密钥打进 .scf-build/.env（避 YAML 501）；临时 overlay / build .env 在 exit 删除。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseEnvFileArg,
  usageEnvFile,
} from '../../../../scripts/lib/env-file-arg'
import { parseDotenvFile } from '../../../../scripts/lib/dotenv-file'
import { run, runDiscarded, which } from '../../../../scripts/lib/spawn'

const PROVIDER_ROOT = resolve(import.meta.dirname, '..')
const FAAS_ROOT = resolve(PROVIDER_ROOT, '../..')
const BUILD_DIR = resolve(PROVIDER_ROOT, '.scf-build')

const REQUIRED_KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'SCF_FUNCTION_NAME',
] as const

const OPTIONAL_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'QQBOT_APP_ID',
  'QQBOT_APP_SECRET',
  'QQBOT_USER_OPENID',
] as const

/** 覆盖 serverless.yml 中 inputs.name（去掉 ${stage} 占位） */
export function patchServerlessFunctionName(
  yml: string,
  functionName: string,
): string {
  if (!/^\s*name:\s*.+$/m.test(yml)) {
    throw new Error('serverless.yml missing inputs.name')
  }
  return yml.replace(/^\s*name:\s*.+$/m, `  name: ${functionName}`)
}

function scfCommand(): string {
  if (which('scf')) return 'scf'
  if (which('serverless-cloud-framework')) return 'serverless-cloud-framework'
  console.error(
    'Missing Serverless Cloud Framework CLI. Install: npm i -g serverless-cloud-framework',
  )
  console.error('Docs: https://cloud.tencent.com/document/product/1154/50938')
  process.exit(1)
}

function loadSecrets(envFile: string): Record<string, string> {
  if (!existsSync(envFile)) {
    console.error(`Missing ${envFile}`)
    process.exit(1)
  }
  const map = parseDotenvFile(envFile)
  const out: Record<string, string> = {}
  for (const key of REQUIRED_KEYS) {
    const v = map[key]?.trim() ?? ''
    if (!v) {
      console.error(`${key} must be non-empty in ${envFile}`)
      process.exit(1)
    }
    out[key] = map[key]!
  }
  for (const key of OPTIONAL_KEYS) {
    out[key] = map[key] ?? ''
  }
  return out
}

function writeBundleEnv(values: Record<string, string>, dest: string): void {
  const body = Object.entries(values)
    .filter(([k]) => k !== 'SCF_FUNCTION_NAME' && k !== 'FC_FUNCTION_NAME')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n')
  writeFileSync(dest, `${body}\n`, { mode: 0o600 })
}

function buildBundle(buildEnvFile: string): void {
  mkdirSync(BUILD_DIR, { recursive: true })
  const outBin = resolve(BUILD_DIR, 'bootstrap')
  console.error('Building linux/amd64 bootstrap from faas/cmd/api...')
  const built = run(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', outBin, './cmd/api'],
    {
      cwd: FAAS_ROOT,
      env: {
        ...process.env,
        GOOS: 'linux',
        GOARCH: 'amd64',
        CGO_ENABLED: '0',
      },
    },
  )
  if ((built.status ?? 1) !== 0) {
    console.error(built.stderr || built.stdout || 'go build failed')
    process.exit(1)
  }
  copyFileSync(
    resolve(PROVIDER_ROOT, 'scf_bootstrap.template'),
    resolve(BUILD_DIR, 'scf_bootstrap'),
  )
  chmodSync(resolve(BUILD_DIR, 'scf_bootstrap'), 0o755)
  copyFileSync(buildEnvFile, resolve(BUILD_DIR, '.env'))
  writeFileSync(
    resolve(BUILD_DIR, '.build-stamp'),
    `built ${new Date().toISOString()}\n`,
  )
}

async function main(): Promise<void> {
  const envFile = parseEnvFileArg()
  if (!envFile) {
    console.error(usageEnvFile('deploy.ts'))
    process.exit(1)
  }

  const values = loadSecrets(envFile)
  const functionName = values.SCF_FUNCTION_NAME.trim()

  for (const [k, v] of Object.entries(values)) {
    process.env[k] = v
  }

  const tmpYml = resolve(PROVIDER_ROOT, `.serverless-deploy-overlay.yml`)
  const buildEnv = resolve(BUILD_DIR, '.env')
  const stagingEnv = resolve(PROVIDER_ROOT, `.env.scf.bundle`)

  const cleanup = () => {
    for (const p of [tmpYml, buildEnv, stagingEnv]) {
      if (existsSync(p)) rmSync(p, { force: true })
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  console.error(
    `Ensure console Web function ${functionName} exists (no CLS) before first deploy.`,
  )

  writeBundleEnv(values, stagingEnv)
  const baseYml = readFileSync(resolve(PROVIDER_ROOT, 'serverless.yml'), 'utf8')
  writeFileSync(tmpYml, patchServerlessFunctionName(baseYml, functionName), 'utf8')

  const scfBin = scfCommand()
  buildBundle(stagingEnv)

  console.error(
    `deploying SCF function=${functionName} (scf output discarded where possible)`,
  )

  const code = runDiscarded(scfBin, ['deploy', '-t', tmpYml], {
    cwd: PROVIDER_ROOT,
    env: process.env,
  })
  if (code !== 0) {
    // 部分 CLI 用 --config；再试一次 inputs 覆盖
    const code2 = runDiscarded(
      scfBin,
      ['deploy', '--inputs', JSON.stringify({ name: functionName })],
      { cwd: PROVIDER_ROOT, env: process.env },
    )
    if (code2 !== 0) {
      console.error(
        `SCF deploy FAILED (function=${functionName}). Ensure you ran: cd faas/providers/tencent-scf && scf login`,
      )
      console.error(
        `If the function is missing: create Web CustomRuntime "${functionName}" in console (ap-guangzhou, no CLS), then retry.`,
      )
      process.exit(code2 || code)
    }
  }
  console.error(`SCF deploy OK (function=${functionName}).`)
  console.error(
    'Paste SCF Base URL into Settings → API Accelerate URL (never commit).',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
