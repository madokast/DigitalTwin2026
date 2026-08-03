/**
 * 顶层部署分发：不收集密钥。
 *
 *   npm run deploy -- test   # 常驻 .env.test；跳过 Vercel；可选 FC/SCF
 *   npm run deploy -- prod   # 先问 Vercel/FC/SCF（默认 N）；任一 Y 才 collect → .env.prod 再分发
 *
 * exit / SIGINT：删除 .env.prod 及本进程登记的临时 *env*。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { askLine, createRl, isYes } from './lib/cli-prompt'
import { parseDotenvFile, writeFcEnvFile } from './lib/dotenv-file'
import { run, which } from './lib/spawn'
import {
  SUPPRESS_BOT_NOTIFICATION,
  withForcedSuppressBotNotification,
} from './lib/suppress-bot-notification-deploy'
import { PROD_ENV_FILE, REPO_ROOT, TEST_ENV_FILE } from './lib/test-env'

/** 与 FC/SCF 一致：默认 N；prod 才询问 */
export const PROMPT_DEPLOY_VERCEL = 'Deploy Vercel production? [y/N] '
export const PROMPT_DEPLOY_ALIYUN_FC = 'Deploy Aliyun FC? [y/N] '
export const PROMPT_DEPLOY_TENCENT_SCF = 'Deploy Tencent SCF? [y/N] '

export const USAGE =
  'usage: npm run deploy -- test|prod\n' +
  '  test  Use permanent .env.test; skip Vercel; optional FC/SCF\n' +
  '  prod  Ask Vercel/FC/SCF (default N); collect → .env.prod only if any Y'

export type DeployChoices = {
  vercel: boolean
  fc: boolean
  scf: boolean
}

/** Deploy …? [y/N] → deploy | skip（默认 N） */
export function cloudDeployDecision(ans: string): 'deploy' | 'skip' {
  return isYes(ans) ? 'deploy' : 'skip'
}

export function anyDeployChosen(c: DeployChoices): boolean {
  return c.vercel || c.fc || c.scf
}

export function parseDeployTarget(
  argv: string[] = process.argv.slice(2),
): 'test' | 'prod' | null {
  const a = argv[0]?.trim()
  if (a === 'test' || a === 'prod') return a
  return null
}

/** Vercel production upsert 白名单（含 SUPPRESS；值由 deploy 强制） */
export const VERCEL_KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'QQBOT_APP_ID',
  'QQBOT_APP_SECRET',
  'QQBOT_USER_OPENID',
  SUPPRESS_BOT_NOTIFICATION,
] as const

/** test 路径强制注入用的临时 env（不改常驻 .env.test） */
export const DEPLOY_TEST_ENV_OVERLAY = resolve(
  REPO_ROOT,
  '.env.deploy-test.overlay',
)

const REQUIRED_RUNTIME_KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
] as const

const FC_DIR = resolve(REPO_ROOT, 'faas/providers/aliyun-fc')
const SCF_DIR = resolve(REPO_ROOT, 'faas/providers/tencent-scf')

const tempPaths = new Set<string>()

export function registerTempPath(path: string): void {
  tempPaths.add(path)
}

export function cleanupRegisteredTemps(): void {
  for (const f of [PROD_ENV_FILE, ...tempPaths]) {
    if (existsSync(f)) {
      rmSync(f, { force: true })
      console.log(`Deleted temp file ${f}`)
    }
  }
  tempPaths.clear()
}

function assertRuntimeKeys(envFile: string, map: Record<string, string>): void {
  for (const key of REQUIRED_RUNTIME_KEYS) {
    if (!map[key]?.trim()) {
      console.error(`${key} required in ${envFile}`)
      process.exit(1)
    }
  }
}

function upsertVercelProd(key: string, value: string): void {
  const attempts: { label: string; args: string[] }[] = [
    {
      label: 'updated',
      args: [
        'env',
        'update',
        key,
        'production',
        '--value',
        value,
        '--sensitive',
        '-y',
      ],
    },
    {
      label: 'upserted (--force)',
      args: [
        'env',
        'add',
        key,
        'production',
        '--value',
        value,
        '--sensitive',
        '--force',
        '-y',
      ],
    },
  ]

  for (const a of attempts) {
    const r = run('vercel', a.args, { cwd: REPO_ROOT })
    if ((r.status ?? 1) === 0) {
      console.log(`Vercel production: ${a.label} ${key}`)
      return
    }
  }

  run('vercel', ['env', 'rm', key, '-y'], { cwd: REPO_ROOT })
  const r = run(
    'vercel',
    [
      'env',
      'add',
      key,
      'production',
      '--value',
      value,
      '--sensitive',
      '-y',
    ],
    { cwd: REPO_ROOT },
  )
  if ((r.status ?? 1) === 0) {
    console.log(
      `Vercel production: replaced ${key} (removed old multi-env entry first)`,
    )
    return
  }

  console.error(`Failed to write Vercel ${key}:`)
  console.error(
    r.stderr
      .split('\n')
      .filter((l) => !/postgresql:\/\/|postgres:\/\/|--value/.test(l))
      .slice(-20)
      .join('\n'),
  )
  process.exit(1)
}

function preflightVercel(): void {
  console.log('Checking Vercel CLI...')
  if (!which('vercel')) {
    console.error(
      'vercel command not found. Run: npm i -g vercel && vercel login',
    )
    process.exit(1)
  }
  const who = run('vercel', ['whoami'], { cwd: REPO_ROOT })
  if ((who.status ?? 1) !== 0) {
    console.error('Vercel not logged in or token invalid:')
    console.error(who.stderr || who.stdout)
    console.error('Run: vercel login')
    process.exit(1)
  }
  console.log(`  Logged in as: ${(who.stdout || who.stderr).trim()}`)
  if (!existsSync(resolve(REPO_ROOT, '.vercel/project.json'))) {
    console.error(
      'This repo is not linked to a Vercel project (missing .vercel/project.json).',
    )
    console.error('Run vercel link from the repo root.')
    process.exit(1)
  }
  console.log(`  Linked: ${resolve(REPO_ROOT, '.vercel/project.json')}`)
}

function preflightS(): void {
  console.log('Checking Serverless Devs (s / FC deploy)...')
  if (!which('s')) {
    console.error('s command not found. Install: npm i -g @serverless-devs/s')
    process.exit(1)
  }
  const ver = run('s', ['-v'])
  console.log(
    `  s: ${(ver.stdout || ver.stderr).trim().split('\n')[0] || 'ok'}`,
  )

  const syaml = readFileSync(resolve(FC_DIR, 's.yaml'), 'utf8')
  const access = syaml.match(/^access:\s*(\S+)/m)?.[1]
  if (!access) {
    console.error('Cannot read access alias from faas/providers/aliyun-fc/s.yaml.')
    process.exit(1)
  }
  console.log(`  s.yaml access: ${access}`)

  const cfg = run('s', ['config', 'get', '-a', access])
  if ((cfg.status ?? 1) !== 0 || !/AccessKeyID/.test(cfg.stdout + cfg.stderr)) {
    console.error(`s config alias unavailable: ${access}`)
    console.error(cfg.stderr || cfg.stdout)
    console.error(`Run: s config add (alias: ${access})`)
    process.exit(1)
  }
  console.log(`  Credentials: configured (${access})`)
}

function preflightScf(): void {
  const bin = which('scf') || which('serverless-cloud-framework')
  if (!bin) {
    console.error(
      'Missing Serverless Cloud Framework CLI. Install: npm i -g serverless-cloud-framework',
    )
    process.exit(1)
  }
  console.log(`SCF CLI OK`)
}

function runProviderDeploy(
  provider: 'fc' | 'scf',
  envFile: string,
): void {
  const script =
    provider === 'fc'
      ? resolve(FC_DIR, 'scripts/deploy.ts')
      : resolve(SCF_DIR, 'scripts/deploy.ts')
  const label = provider === 'fc' ? 'Aliyun FC' : 'Tencent SCF'
  console.log(`Deploying ${label} (env-file=${envFile})...`)
  const dep = spawnSync(
    'npx',
    ['tsx', script, '--env-file', envFile],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        DT_SKIP_NOTIFY_PROMPT: '1',
        DT_SKIP_TELEGRAM_PROMPT: '1',
      },
    },
  )
  if ((dep.status ?? 1) !== 0) {
    console.error(`${label} deploy failed.`)
    process.exit(1)
  }
}

function deployVercel(values: Record<string, string>): void {
  console.log('')
  console.log('--- Vercel ---')
  preflightVercel()
  for (const key of VERCEL_KEYS) {
    if (key in values) upsertVercelProd(key, values[key] ?? '')
  }
  console.log('Note: will run vercel deploy --prod')
  console.log('')

  console.log('--- Redeploy Vercel Production ---')
  const vd = spawnSync('vercel', ['deploy', '--prod', '--yes'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  })
  if ((vd.status ?? 1) !== 0) {
    console.error(
      'Vercel deploy --prod failed. Env was written; retry manually: vercel deploy --prod',
    )
    process.exit(1)
  }
  console.log('Vercel production deploy OK.')
}

/** prod：先问三个目标（默认 N）；test：不写 vercel */
async function askDeployChoices(mode: 'test' | 'prod'): Promise<DeployChoices> {
  const rl = createRl()
  try {
    console.log('')
    console.log('--- Deploy targets (default N) ---')
    let vercel = false
    if (mode === 'prod') {
      const vAns = await askLine(rl, PROMPT_DEPLOY_VERCEL)
      vercel = cloudDeployDecision(vAns) === 'deploy'
    } else {
      console.log('Skipping Vercel (test).')
    }

    const fcAns = await askLine(rl, PROMPT_DEPLOY_ALIYUN_FC)
    const fc = cloudDeployDecision(fcAns) === 'deploy'

    const scfAns = await askLine(rl, PROMPT_DEPLOY_TENCENT_SCF)
    const scf = cloudDeployDecision(scfAns) === 'deploy'

    return { vercel, fc, scf }
  } finally {
    rl.close()
  }
}

function runSelectedDeploys(
  choices: DeployChoices,
  envFile: string,
  values: Record<string, string>,
): string[] {
  const deployed: string[] = []

  if (choices.vercel) {
    deployVercel(values)
    deployed.push('Vercel')
  } else if (envFile === PROD_ENV_FILE) {
    console.log('Skipped Vercel deploy.')
  }

  if (choices.fc) {
    console.log('')
    console.log('--- Aliyun FC ---')
    preflightS()
    console.log('')
    runProviderDeploy('fc', envFile)
    deployed.push('Aliyun FC')
  } else {
    console.log('Skipped Aliyun FC deploy.')
  }

  if (choices.scf) {
    console.log('')
    console.log('--- Tencent SCF ---')
    preflightScf()
    console.log('')
    runProviderDeploy('scf', envFile)
    deployed.push('Tencent SCF')
  } else {
    console.log('Skipped Tencent SCF deploy.')
  }

  return deployed
}

function runCollectProdEnv(): void {
  console.log('--- Collect production secrets ---')
  const r = spawnSync(
    'npx',
    ['tsx', resolve(REPO_ROOT, 'scripts/collect-prod-env.ts')],
    { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
  )
  if ((r.status ?? 1) !== 0) {
    console.error('collect-prod-env failed.')
    process.exit(1)
  }
  if (!existsSync(PROD_ENV_FILE)) {
    console.error(`Expected ${PROD_ENV_FILE} after collect-prod-env.`)
    process.exit(1)
  }
}

function printDone(deployed: string[]): void {
  console.log('')
  console.log('=== Done ===')
  console.log(`Deployed: ${deployed.join(', ') || '(none)'}`)
  if (!deployed.includes('Vercel')) {
    console.log(
      'Vercel: skipped. Re-run npm run deploy -- prod and answer Y to Deploy Vercel production? if needed.',
    )
  }
  if (!deployed.includes('Aliyun FC')) {
    console.log(
      'Aliyun FC: skipped. Use npm run fc:deploy -- --env-file .env.prod later if needed (prefer npm run deploy -- prod).',
    )
  }
  if (!deployed.includes('Tencent SCF')) {
    console.log(
      'Tencent SCF: skipped. Use npm run scf:deploy -- --env-file .env.prod later if needed (prefer npm run deploy -- prod).',
    )
  }
  console.log(
    'Paste your chosen China Accelerate Base URL (FC or SCF) into Settings → API Accelerate URL; leave empty for same-origin Vercel. Never commit the URL.',
  )
}

async function deployTest(): Promise<void> {
  console.log('=== Deploy test (FaaS optional; no Vercel) ===')
  if (!existsSync(TEST_ENV_FILE)) {
    console.error(
      `Missing ${TEST_ENV_FILE}. Copy from .env.test.example and fill secrets.`,
    )
    process.exit(1)
  }
  const map = parseDotenvFile(TEST_ENV_FILE)
  assertRuntimeKeys(TEST_ENV_FILE, map)
  console.log(`Using permanent ${TEST_ENV_FILE}`)

  const choices = await askDeployChoices('test')
  if (!anyDeployChosen(choices)) {
    console.log('Nothing selected to deploy. Exiting.')
    return
  }

  // 强制 SUPPRESS=1（覆盖漏写/误值）；写临时 overlay，不改常驻 .env.test
  const values = withForcedSuppressBotNotification(map, 'test')
  writeFcEnvFile(DEPLOY_TEST_ENV_OVERLAY, values)
  registerTempPath(DEPLOY_TEST_ENV_OVERLAY)
  const onCleanup = () => {
    cleanupRegisteredTemps()
  }
  process.on('exit', onCleanup)
  process.on('SIGINT', () => {
    onCleanup()
    process.exit(130)
  })
  console.log(
    `Forced ${SUPPRESS_BOT_NOTIFICATION}=1 for test cloud deploy (overlay; not prompted)`,
  )

  const deployed = runSelectedDeploys(
    choices,
    DEPLOY_TEST_ENV_OVERLAY,
    values,
  )
  console.log('')
  console.log('=== Done ===')
  console.log(`Deployed: ${deployed.join(', ') || '(none)'}`)
}

async function deployProd(): Promise<void> {
  console.log('=== Deploy prod (Vercel / FC / SCF optional; default N) ===')
  console.log('Do NOT commit secrets to git.')
  console.log('')

  const choices = await askDeployChoices('prod')
  if (!anyDeployChosen(choices)) {
    console.log('Nothing selected to deploy. Exiting.')
    return
  }

  registerTempPath(PROD_ENV_FILE)
  const onCleanup = () => {
    cleanupRegisteredTemps()
  }
  process.on('exit', onCleanup)
  process.on('SIGINT', () => {
    onCleanup()
    process.exit(130)
  })

  runCollectProdEnv()
  // collect 已写 =0；此处再强制一次，覆盖手改或误带的 1
  const raw = parseDotenvFile(PROD_ENV_FILE)
  const values = withForcedSuppressBotNotification(raw, 'prod')
  writeFcEnvFile(PROD_ENV_FILE, values)
  assertRuntimeKeys(PROD_ENV_FILE, values)
  console.log(
    `Forced ${SUPPRESS_BOT_NOTIFICATION}=0 for prod (not prompted)`,
  )

  const deployed = runSelectedDeploys(choices, PROD_ENV_FILE, values)
  printDone(deployed)
}

async function main(): Promise<void> {
  const target = parseDeployTarget()
  if (!target) {
    console.error(USAGE)
    process.exit(1)
  }
  if (target === 'test') await deployTest()
  else await deployProd()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
