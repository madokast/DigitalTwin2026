/**
 * 交互式刷新「生产」环境变量：Vercel production 必做；
 * 阿里云 FC / 腾讯云 SCF 默认跳过，仅在用户确认后才预检并部署。
 *
 * 用法（仓库根）: npm run secrets:refresh-prod
 * 勿把输入的密钥提交 git。
 */
import {
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Interface as ReadlineInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
import {
  askLine,
  askSecret,
  createRl,
  isYes,
  trimInput,
} from './lib/cli-prompt'
import { writeFcEnvFile } from './lib/dotenv-file'
import { maskValue } from './lib/mask'
import {
  promptQqbotChannel,
  promptTelegramChannel,
} from './lib/notify-prompt'
import { run, which } from './lib/spawn'

const ROOT = resolve(import.meta.dirname, '..')
const FC_DIR = resolve(ROOT, 'faas/providers/aliyun-fc')
const PROD_ENV_FILE = resolve(FC_DIR, '.env.fc.prod')

/** 与 docs/20260802-faas-multi-cloud.md §4 / Task 3 对齐的提示文案 */
export const PROMPT_DEPLOY_ALIYUN_FC = 'Deploy Aliyun FC prod? [y/N] '
export const PROMPT_DEPLOY_TENCENT_SCF = 'Deploy Tencent SCF prod? [y/N] '
export const PROMPT_CONFIRM_VERCEL =
  'Upsert UPDATE keys on Vercel production, then vercel deploy --prod. Continue? [y/N] '

/** SCF 尚未实现时的英文说明（选 Y 时打印，不 fail 整脚本） */
export const SCF_NOT_IMPLEMENTED_MESSAGE = [
  'Tencent Cloud SCF provider scaffold exists under faas/providers/tencent-scf.',
  'Automatic refresh-prod → scf deploy is still pending; for a manual deploy:',
  '  1. npm i -g serverless-cloud-framework',
  '  2. cd faas/providers/tencent-scf && ./scripts/login.sh',
  '     (open the printed https://slslogin.qcloud.com/... link)',
  '  3. cp env.scf.example .env.scf.prod && fill secrets',
  '  4. npx tsx scripts/deploy.ts prod',
  'Skipping automatic SCF deploy for this refresh-prod run.',
].join('\n')

const KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'QQBOT_APP_ID',
  'QQBOT_APP_SECRET',
  'QQBOT_USER_OPENID',
] as const

type Key = (typeof KEYS)[number]

export const REQUIRED_KEYS: Key[] = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
]

type PromptResult = { action: 'skip' | 'set'; value: string }

/** 空输入分支：前三项必填拒绝；其它键不应再走 promptKv */
export function emptyInputPolicy(key: Key): 'reject' | 'skip' {
  if (REQUIRED_KEYS.includes(key)) return 'reject'
  return 'skip'
}

/** Deploy …? [y/N] → deploy | skip（默认 N） */
export function cloudDeployDecision(ans: string): 'deploy' | 'skip' {
  return isYes(ans) ? 'deploy' : 'skip'
}

async function verifyDatabaseUrl(url: string): Promise<boolean> {
  console.error('Verifying DATABASE_URL connectivity...')
  const sql = postgres(url, { max: 1, ssl: 'require', connect_timeout: 15 })
  try {
    await sql`select 1 as ok`
    const r = await sql`select to_regclass('public.records')::text as t`
    if (!r[0]?.t) {
      console.error(
        'warn: public.records does not exist; confirm you ran npm run db:migrate on production',
      )
    } else {
      console.error('ok: connected, public.records exists')
    }
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const safe = msg
      .split('\n')
      .filter((l) => !/postgresql:\/\/|postgres:\/\/|DATABASE_URL=/.test(l))
      .slice(-8)
      .join('\n')
    console.error(
      'DATABASE_URL unreachable (error summary, connection string omitted):',
    )
    console.error(safe || msg)
    return false
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

async function promptKv(
  rl: ReadlineInterface,
  key: Key,
): Promise<PromptResult> {
  for (;;) {
    const val = trimInput(
      await askSecret(rl, `Enter ${key} (required; empty not allowed): `),
    )

    if (!val) {
      console.error(`  ${key} cannot be empty. Please enter a value.`)
      console.error('')
      continue
    }

    if (key === 'DATABASE_URL') {
      if (!(await verifyDatabaseUrl(val))) {
        console.error('Connection failed, please re-enter DATABASE_URL.')
        console.error('')
        continue
      }
    }

    console.error(`  Preview: ${maskValue(val)}`)
    if (isYes(await askLine(rl, 'Confirm? [y/N] '))) {
      return { action: 'set', value: val }
    }
    console.error('Try again.')
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
    const r = run('vercel', a.args, { cwd: ROOT })
    if ((r.status ?? 1) === 0) {
      console.log(`Vercel production: ${a.label} ${key}`)
      return
    }
  }

  run('vercel', ['env', 'rm', key, '-y'], { cwd: ROOT })
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
    { cwd: ROOT },
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
  const who = run('vercel', ['whoami'], { cwd: ROOT })
  if ((who.status ?? 1) !== 0) {
    console.error('Vercel not logged in or token invalid:')
    console.error(who.stderr || who.stdout)
    console.error('Run: vercel login')
    process.exit(1)
  }
  console.log(`  Logged in as: ${(who.stdout || who.stderr).trim()}`)
  if (!existsSync(resolve(ROOT, '.vercel/project.json'))) {
    console.error(
      'This repo is not linked to a Vercel project (missing .vercel/project.json).',
    )
    console.error('Run vercel link from the repo root.')
    process.exit(1)
  }
  console.log(`  Linked: ${resolve(ROOT, '.vercel/project.json')}`)
}

/** 仅在用户选择 Deploy Aliyun FC = Y 之后调用 */
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

  const info = run('s', ['info', '--env', 'prod'], {
    cwd: FC_DIR,
    env: {
      ...process.env,
      DATABASE_URL: '',
      DIGITAL_TWIN_TOKEN: '',
      DIGITAL_TWIN_ADMIN_TOKEN: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_USER_ID: '',
      QQBOT_APP_ID: '',
      QQBOT_APP_SECRET: '',
      QQBOT_USER_OPENID: '',
    },
  })
  const blob = info.stdout + info.stderr
  if (/invalid access key|AccessKeyId|403|Unauthorized|credential/i.test(blob)) {
    console.error('s / Alibaba Cloud auth failed:')
    console.error(
      blob
        .split('\n')
        .filter((l) => /Error|invalid|403|Unauthorized|Message/i.test(l))
        .slice(0, 8)
        .join('\n') || blob.slice(-500),
    )
    console.error(`Check: s config get -a ${access}`)
    process.exit(1)
  }
  if (blob.includes('digitaltwin-api-prod')) {
    console.log('  FC prod exists (can update deploy)')
  } else {
    console.log(
      '  FC prod not deployed yet (this script will create digitaltwin-api-prod)',
    )
  }
}

function cleanupProdEnv(): void {
  if (existsSync(PROD_ENV_FILE)) {
    rmSync(PROD_ENV_FILE, { force: true })
    console.log(`Deleted temp file ${PROD_ENV_FILE}`)
  }
}

function deployAliyunFcProd(values: Record<Key, string>): void {
  preflightS()
  console.log('')

  writeFcEnvFile(PROD_ENV_FILE, { ...values })
  console.log(`Temporarily wrote ${PROD_ENV_FILE} (deleted after deploy)`)

  console.log('Deploying FC prod...')
  // refresh-prod 已写好并探测过：跳过 deploy 二次渠道询问
  const dep = spawnSync(
    'npx',
    ['tsx', resolve(FC_DIR, 'scripts/deploy.ts'), 'prod'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        DT_SKIP_NOTIFY_PROMPT: '1',
        DT_SKIP_TELEGRAM_PROMPT: '1',
      },
    },
  )
  if ((dep.status ?? 1) !== 0) {
    console.error('FC deploy failed.')
    process.exit(1)
  }

  const info = run('bash', [resolve(FC_DIR, 'scripts/info.sh'), 'prod'], {
    cwd: FC_DIR,
    env: process.env,
  })
  console.log(
    `FC Base URL: ${info.stdout.trim() || '(see ./faas/providers/aliyun-fc/scripts/info.sh prod)'}`,
  )
}

function handleTencentScfStub(): void {
  console.log(SCF_NOT_IMPLEMENTED_MESSAGE)
}

async function main(): Promise<void> {
  console.log(
    '=== Refresh production secrets (Vercel required; FC/SCF optional) ===',
  )
  console.log(
    'Vercel production is always updated. Aliyun FC and Tencent SCF default to skip.',
  )
  console.log('Do NOT commit these values to git or paste in chat logs.')
  console.log('Flow:')
  console.log(
    '  - DATABASE_URL / DIGITAL_TWIN_TOKEN / DIGITAL_TWIN_ADMIN_TOKEN: required every run',
  )
  console.log(
    '  - Enable Telegram notify? [y/N] → N clears TELEGRAM_*; Y requires both keys + probe',
  )
  console.log(
    '  - Enable QQ Bot notify? [y/N] → N clears QQBOT_*; Y requires three keys + C2C probe',
  )
  console.log('  - Upsert Vercel production + vercel deploy --prod')
  console.log(`  - ${PROMPT_DEPLOY_ALIYUN_FC.trim()} (default N)`)
  console.log(`  - ${PROMPT_DEPLOY_TENCENT_SCF.trim()} (default N)`)
  console.log('  - Connectivity checks for DATABASE_URL and enabled notify channels')
  console.log('')

  preflightVercel()
  console.log('')

  const cleanup = () => {
    cleanupProdEnv()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  const values = {} as Record<Key, string>
  const updated = {} as Record<Key, boolean>

  const rl = createRl()
  try {
    for (const key of REQUIRED_KEYS) {
      const result = await promptKv(rl, key)
      values[key] = result.value
      updated[key] = true
      console.log('')
    }

    console.log('--- Notify channels ---')
    const tg = await promptTelegramChannel(rl, {
      probeText: 'DigitalTwin2026 prod env verify',
    })
    values.TELEGRAM_BOT_TOKEN = tg.TELEGRAM_BOT_TOKEN
    values.TELEGRAM_USER_ID = tg.TELEGRAM_USER_ID
    updated.TELEGRAM_BOT_TOKEN = true
    updated.TELEGRAM_USER_ID = true
    console.log('')

    const qq = await promptQqbotChannel(rl, {
      probeText: 'DigitalTwin2026 prod env verify',
    })
    values.QQBOT_APP_ID = qq.QQBOT_APP_ID
    values.QQBOT_APP_SECRET = qq.QQBOT_APP_SECRET
    values.QQBOT_USER_OPENID = qq.QQBOT_USER_OPENID
    updated.QQBOT_APP_ID = true
    updated.QQBOT_APP_SECRET = true
    updated.QQBOT_USER_OPENID = true
    console.log('')
  } finally {
    rl.close()
  }

  for (const key of REQUIRED_KEYS) {
    if (!values[key]) {
      console.error(`Missing required ${key} (internal error; should have been prompted).`)
      process.exit(1)
    }
  }

  let anyUpdate = false
  console.log('Summary (masked):')
  for (const key of KEYS) {
    if (updated[key]) {
      anyUpdate = true
      console.log(
        values[key]
          ? `  ${key}: ${maskValue(values[key])}  [UPDATE]`
          : `  ${key}: (empty)  [UPDATE]`,
      )
    } else {
      console.log(
        values[key]
          ? `  ${key}: ${maskValue(values[key])}  [keep]`
          : `  ${key}: (unset)  [keep]`,
      )
    }
  }

  const rl2 = createRl()
  let go = ''
  try {
    go = await askLine(rl2, PROMPT_CONFIRM_VERCEL)
  } finally {
    rl2.close()
  }
  if (!isYes(go)) {
    console.log('Cancelled.')
    process.exit(0)
  }

  const deployed: string[] = []

  console.log('')
  console.log('--- Vercel ---')
  if (!anyUpdate) {
    console.log('No env upserts (code-only).')
  } else {
    for (const key of KEYS) {
      if (updated[key]) upsertVercelProd(key, values[key])
      else console.log(`Vercel production: skip ${key}`)
    }
  }
  console.log('Note: will run vercel deploy --prod')
  console.log('')

  console.log('--- Redeploy Vercel Production ---')
  const vd = spawnSync('vercel', ['deploy', '--prod', '--yes'], {
    cwd: ROOT,
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
  deployed.push('Vercel')

  const rlCloud = createRl()
  let fcAns = ''
  let scfAns = ''
  try {
    console.log('')
    console.log('--- Optional: Aliyun FC ---')
    fcAns = await askLine(rlCloud, PROMPT_DEPLOY_ALIYUN_FC)
    if (cloudDeployDecision(fcAns) === 'deploy') {
      console.log('')
      deployAliyunFcProd(values)
      deployed.push('Aliyun FC')
    } else {
      console.log('Skipped Aliyun FC deploy.')
    }

    console.log('')
    console.log('--- Optional: Tencent SCF ---')
    scfAns = await askLine(rlCloud, PROMPT_DEPLOY_TENCENT_SCF)
    if (cloudDeployDecision(scfAns) === 'deploy') {
      console.log('')
      handleTencentScfStub()
      // 不加入 deployed：未真正部署
    } else {
      console.log('Skipped Tencent SCF deploy.')
    }
  } finally {
    rlCloud.close()
  }

  console.log('')
  console.log('=== Done ===')
  console.log(`Deployed: ${deployed.join(', ') || '(none)'}`)
  if (!deployed.includes('Aliyun FC')) {
    console.log(
      'Aliyun FC: skipped (or not requested). Use npm run fc:deploy -- prod later if needed.',
    )
  }
  console.log(
    'Paste your chosen China Accelerate Base URL (FC or SCF when available) into Settings → API Accelerate URL; leave empty for same-origin Vercel. Never commit the URL.',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
