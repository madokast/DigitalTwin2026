/**
 * 用法: npx tsx faas/providers/tencent-scf/scripts/deploy.ts --env-file <path>
 * 或: ENV_FILE=<path> npm run scf:deploy
 *
 * 不感知 test/prod；无 stdin。从 env 文件读密钥与 SCF_FUNCTION_NAME。
 * 密钥打进 .scf-build/.env（避 YAML 501）；临时 patched serverless.yml / build .env 在 exit 删除。
 *
 * 注意：scf CLI 没有「-t 指定模板文件」；`-t` 会被忽略并仍读 cwd 的 serverless.yml。
 * 因此用临时替换 serverless.yml（备份 → 写入 patched → deploy → 还原）覆盖 inputs.name。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
import { run, runInherited, which } from '../../../../scripts/lib/spawn'

const PROVIDER_ROOT = resolve(import.meta.dirname, '..')
const FAAS_ROOT = resolve(PROVIDER_ROOT, '../..')
const BUILD_DIR = resolve(PROVIDER_ROOT, '.scf-build')
const SERVERLESS_YML = resolve(PROVIDER_ROOT, 'serverless.yml')
const SERVERLESS_YML_BAK = resolve(PROVIDER_ROOT, '.serverless.yml.deploy-bak')

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

/**
 * 只覆盖 inputs.name（两空格缩进），不动顶层 component 的 name。
 * SCF CLI banner 的 Name 仍是组件实例名；云函数名才是 inputs.name。
 */
export function patchServerlessFunctionName(
  yml: string,
  functionName: string,
): string {
  const re = /^ {2}name:\s*.+$/m
  if (!re.test(yml)) {
    throw new Error('serverless.yml missing inputs.name (expected "  name: ...")')
  }
  return yml.replace(re, `  name: ${functionName}`)
}

/** 供测试 / dry-run：生成将交给 scf deploy 的 serverless.yml 正文 */
export function buildDeployServerlessYml(
  baseYml: string,
  functionName: string,
): string {
  const trimmed = functionName.trim()
  if (!trimmed) {
    throw new Error('SCF_FUNCTION_NAME must be non-empty')
  }
  // SCF：字母开头，字母/数字/连字符/下划线，长度 2–60
  if (!/^[A-Za-z][\w-]{0,58}[A-Za-z0-9]$/.test(trimmed)) {
    throw new Error(
      `invalid SCF_FUNCTION_NAME "${trimmed}" (2–60 chars, start with letter, end with letter/digit)`,
    )
  }
  return patchServerlessFunctionName(baseYml, trimmed)
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

/** 临时把 patched yml 落到 serverless.yml，调用后务必 restore */
function withPatchedServerlessYml<T>(patched: string, fn: () => T): T {
  if (!existsSync(SERVERLESS_YML)) {
    throw new Error(`missing ${SERVERLESS_YML}`)
  }
  copyFileSync(SERVERLESS_YML, SERVERLESS_YML_BAK)
  writeFileSync(SERVERLESS_YML, patched, 'utf8')
  try {
    return fn()
  } finally {
    if (existsSync(SERVERLESS_YML_BAK)) {
      renameSync(SERVERLESS_YML_BAK, SERVERLESS_YML)
    }
  }
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

  const buildEnv = resolve(BUILD_DIR, '.env')
  const stagingEnv = resolve(PROVIDER_ROOT, `.env.scf.bundle`)

  const cleanup = () => {
    for (const p of [buildEnv, stagingEnv, SERVERLESS_YML_BAK]) {
      if (existsSync(p)) {
        // 若仍留着 bak，说明中途崩溃；尽量还原正式 yml
        if (p === SERVERLESS_YML_BAK && existsSync(SERVERLESS_YML_BAK)) {
          try {
            renameSync(SERVERLESS_YML_BAK, SERVERLESS_YML)
          } catch {
            rmSync(p, { force: true })
          }
          continue
        }
        rmSync(p, { force: true })
      }
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  writeBundleEnv(values, stagingEnv)
  const baseYml = readFileSync(SERVERLESS_YML, 'utf8')
  const patchedYml = buildDeployServerlessYml(baseYml, functionName)

  // dry 校验：inputs.name 已改、顶层 name 未误改
  if (!patchedYml.includes(`  name: ${functionName}`)) {
    console.error(
      `internal error: patched serverless.yml missing inputs.name=${functionName}`,
    )
    process.exit(1)
  }
  if (!/^name:\s*digitaltwin-api\s*$/m.test(patchedYml)) {
    console.error(
      'internal error: top-level component name was altered (should stay digitaltwin-api)',
    )
    process.exit(1)
  }

  const scfBin = scfCommand()
  buildBundle(stagingEnv)

  console.error(
    `deploying SCF Web function=${functionName} (runtime=Go1, scf_bootstrap → ./bootstrap)…`,
  )
  console.error(
    `Note: CLI banner "Name" is the component instance (digitaltwin-api), not the cloud function name.`,
  )

  const code = withPatchedServerlessYml(patchedYml, () =>
    runInherited(scfBin, ['deploy'], {
      cwd: PROVIDER_ROOT,
      env: process.env,
    }),
  )

  if (code !== 0) {
    console.error(
      `SCF deploy FAILED (expected cloud function name=${functionName}).`,
    )
    console.error(
      `Ensure you ran: cd faas/providers/tencent-scf && scf login`,
    )
    console.error(
      `Web CreateFunction rejects CustomRuntime; use runtime Go1 (console: Go 1) with scf_bootstrap in the zip.`,
    )
    console.error(
      `If create still fails: in console (ap-guangzhou) create Web function "${functionName}", runtime Go 1, 64MB, disable CLS if billed, then retry.`,
    )
    process.exit(code)
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
