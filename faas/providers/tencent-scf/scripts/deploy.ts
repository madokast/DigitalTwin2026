/**
 * 用法: npx tsx faas/providers/tencent-scf/scripts/deploy.ts test|prod
 *
 * 预编译 faas/cmd/api → .scf-build/，再 scf deploy。
 * 硬性规则：尽量丢弃可能含密钥的 scf 输出（对齐阿里云「禁裸 deploy」）。
 * 首次需在本目录完成 `scf login`（浏览器/微信链接）。
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseDotenvFile } from '../../../../scripts/lib/dotenv-file'
import { run, runDiscarded, which } from '../../../../scripts/lib/spawn'

const PROVIDER_ROOT = resolve(import.meta.dirname, '..')
const FAAS_ROOT = resolve(PROVIDER_ROOT, '../..')
const BUILD_DIR = resolve(PROVIDER_ROOT, '.scf-build')

function scfCommand(): string {
  if (which('scf')) return 'scf'
  if (which('serverless-cloud-framework')) return 'serverless-cloud-framework'
  console.error(
    'Missing Serverless Cloud Framework CLI. Install: npm i -g serverless-cloud-framework',
  )
  console.error('Docs: https://cloud.tencent.com/document/product/1154/50938')
  process.exit(1)
}

function loadEnvFile(envName: 'test' | 'prod'): void {
  const envFile = resolve(PROVIDER_ROOT, `.env.scf.${envName}`)
  if (!existsSync(envFile)) {
    console.error(`Missing ${envFile} (copy from env.scf.example).`)
    process.exit(1)
  }
  const map = parseDotenvFile(envFile)
  for (const [k, v] of Object.entries(map)) {
    process.env[k] = v
  }
  for (const key of [
    'DATABASE_URL',
    'DIGITAL_TWIN_TOKEN',
    'DIGITAL_TWIN_ADMIN_TOKEN',
  ] as const) {
    if (!process.env[key]?.trim()) {
      console.error(`${key} must be non-empty in ${envFile}`)
      process.exit(1)
    }
  }
  for (const key of [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_USER_ID',
    'QQBOT_APP_ID',
    'QQBOT_APP_SECRET',
    'QQBOT_USER_OPENID',
  ] as const) {
    if (process.env[key] === undefined) process.env[key] = ''
  }
}

function buildBundle(envName: 'test' | 'prod'): void {
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
  // 密钥进代码包由 bootstrap source；勿写进 serverless.yml（含特殊字符的 URL 会 501）
  copyFileSync(
    resolve(PROVIDER_ROOT, `.env.scf.${envName}`),
    resolve(BUILD_DIR, '.env'),
  )
  writeFileSync(
    resolve(BUILD_DIR, '.build-stamp'),
    `built ${new Date().toISOString()}\n`,
  )
}

function main(): void {
  const envName = process.argv[2]
  if (envName !== 'test' && envName !== 'prod') {
    console.error('usage: deploy.ts test|prod')
    process.exit(1)
  }

  const scfBin = scfCommand()
  loadEnvFile(envName)
  buildBundle(envName)

  console.error(
    `deploying SCF env=${envName} (scf output discarded where possible)`,
  )

  const code = runDiscarded(scfBin, ['deploy'], {
    cwd: PROVIDER_ROOT,
    env: process.env,
  })
  if (code !== 0) {
    console.error(
      `SCF deploy FAILED (env=${envName}). Ensure you ran: cd faas/providers/tencent-scf && scf login`,
    )
    process.exit(code)
  }
  console.error(`SCF deploy OK (env=${envName}).`)
  console.error('Paste SCF Base URL into Settings → API Accelerate URL (never commit).')
}

main()
