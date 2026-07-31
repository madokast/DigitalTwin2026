/**
 * 交互式刷新「生产」环境变量：Vercel production + 阿里云 FC prod。
 *
 * 用法（仓库根）: npm run secrets:refresh-prod
 * 勿把输入的密钥提交 git。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import { readDotenvKey, writeFcEnvFile } from './lib/dotenv-file'
import { maskValue } from './lib/mask'
import { run, which } from './lib/spawn'
import { telegramProbeSend } from './lib/telegram-probe'

const ROOT = resolve(import.meta.dirname, '..')
const FC_DIR = resolve(ROOT, 'fc')
const PROD_ENV_FILE = resolve(FC_DIR, '.env.fc.prod')

const KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
] as const

type Key = (typeof KEYS)[number]

const REQUIRED_KEYS: Key[] = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
]

const OPTIONAL_EMPTY = new Set<Key>([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
])

type PromptResult = { action: 'skip' | 'set'; value: string }

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
  currentHint: string,
): Promise<PromptResult> {
  const allowEmpty = OPTIONAL_EMPTY.has(key)
  for (;;) {
    const prompt = allowEmpty
      ? currentHint
        ? `Enter ${key} (Enter = empty-or-skip; current ${maskValue(currentHint)}): `
        : `Enter ${key} (Enter = empty-or-skip; currently unset): `
      : currentHint
        ? `Enter ${key} (Enter = skip, keep ${maskValue(currentHint)}): `
        : `Enter ${key} (Enter = skip; currently unset — must exist on Vercel if you skip): `

    const val = trimInput(await askSecret(rl, prompt))

    if (!val) {
      if (allowEmpty) {
        const choice = await askLine(
          rl,
          '  Empty input: [e] upsert empty string, [s] skip upsert (keep current)? [s] ',
        )
        if (choice.trim().toLowerCase() === 'e') {
          console.error('  → upsert empty')
          return { action: 'set', value: '' }
        }
      }
      console.error('  → skip')
      return { action: 'skip', value: '' }
    }

    if (key === 'DATABASE_URL') {
      if (!(await verifyDatabaseUrl(val))) {
        console.error(
          'Connection failed, please re-enter DATABASE_URL (or Enter to skip).',
        )
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

function pullVercelProductionEnv(outFile: string): void {
  rmSync(outFile, { force: true })
  const r = run(
    'vercel',
    ['env', 'pull', outFile, '--environment=production', '--yes'],
    { cwd: ROOT },
  )
  if ((r.status ?? 1) !== 0) {
    console.error(
      'warn: vercel env pull failed; skipped keys need a value you type, or pull manually.',
    )
    writeFileSync(outFile, '')
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
    console.error('Cannot read access alias from fc/s.yaml.')
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

async function main(): Promise<void> {
  console.log(
    '=== Refresh production secrets (Vercel production + FC prod) ===',
  )
  console.log(
    'If digitaltwin-api-prod does not exist, temporarily writes .env.fc.prod; deleted after deploy.',
  )
  console.log('Do NOT commit these values to git or paste in chat logs.')
  console.log('Per key:')
  console.log('  - Type a value → confirm → upsert that key')
  console.log('  - Enter on non-empty keys (DB URL / Tokens) → skip upsert')
  console.log('  - Enter on TELEGRAM_* → ask: [e] upsert empty, [s] skip')
  console.log(
    '  - Connectivity checks only when you set a value (skip = no DB/Telegram probe)',
  )
  console.log(
    '  - All skipped → code-only deploy (FC + Vercel), no env upserts',
  )
  console.log('')

  preflightVercel()
  console.log('')
  preflightS()
  console.log('')

  const tmpDir = mkdtempSync(join(tmpdir(), 'dt-pull-'))
  const pullFile = join(tmpDir, '.env.production')
  const cleanup = () => {
    rmSync(tmpDir, { recursive: true, force: true })
    cleanupProdEnv()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  console.log('Pulling current Vercel production env (for skip / FC merge)...')
  pullVercelProductionEnv(pullFile)
  console.log('')

  const values = {} as Record<Key, string>
  const updated = {} as Record<Key, boolean>

  const rl = createRl()
  try {
    for (const key of KEYS) {
      const current = readDotenvKey(pullFile, key)
      const result = await promptKv(rl, key, current)
      if (result.action === 'set') {
        values[key] = result.value
        updated[key] = true
      } else {
        values[key] = current
        updated[key] = false
      }
      console.log('')
    }
  } finally {
    rl.close()
  }

  const tgBot = values.TELEGRAM_BOT_TOKEN
  const tgUid = values.TELEGRAM_USER_ID
  if ((tgBot || tgUid) && !(tgBot && tgUid)) {
    console.error(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID must both be set (or both empty to disable).',
    )
    console.error(
      'One is missing after skip/merge. Re-run and fill both, or set both empty with [e].',
    )
    process.exit(1)
  }

  if (
    tgBot &&
    tgUid &&
    (updated.TELEGRAM_BOT_TOKEN || updated.TELEGRAM_USER_ID)
  ) {
    console.error('Verifying Telegram sendMessage...')
    const err = await telegramProbeSend(
      tgBot,
      tgUid,
      'DigitalTwin2026 prod env verify',
    )
    if (err) {
      console.error(err)
      console.error(
        'Telegram verify failed. Fix values and re-run (or skip both TELEGRAM_*).',
      )
      process.exit(1)
    }
    console.error('ok: Telegram message sent')
    console.log('')
  }

  for (const key of REQUIRED_KEYS) {
    if (!values[key]) {
      console.error(
        `Missing required ${key} after skip (not on Vercel production pull either).`,
      )
      console.error(
        'Enter it this run, or ensure it exists on Vercel production.',
      )
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
    go = await askLine(
      rl2,
      anyUpdate
        ? 'Upsert UPDATE keys on Vercel production, then deploy FC prod + Vercel --prod. Continue? [y/N] '
        : 'All skipped → code-only deploy (FC prod + Vercel --prod), no env upserts. Continue? [y/N] ',
    )
  } finally {
    rl2.close()
  }
  if (!isYes(go)) {
    console.log('Cancelled.')
    process.exit(0)
  }

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

  console.log('--- FC prod ---')
  writeFcEnvFile(PROD_ENV_FILE, { ...values })
  console.log(`Temporarily wrote ${PROD_ENV_FILE} (deleted after deploy)`)

  console.log('Deploying FC prod...')
  // 继承 stdio：deploy.ts 仍会交互确认 Telegram（与旧 shell 行为一致）
  const dep = spawnSync(
    'npx',
    ['tsx', resolve(FC_DIR, 'scripts/deploy.ts'), 'prod'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, DT_SKIP_TELEGRAM_PROMPT: '1' },
    },
  )
  if ((dep.status ?? 1) !== 0) {
    console.error('FC deploy failed.')
    process.exit(1)
  }

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

  console.log('')
  console.log('Done.')
  const info = run('bash', [resolve(FC_DIR, 'scripts/info.sh'), 'prod'], {
    cwd: FC_DIR,
    env: process.env,
  })
  console.log(
    `FC Base URL: ${info.stdout.trim() || '(see ./fc/scripts/info.sh prod)'}`,
  )
  console.log(
    'Paste FC URL into Settings → API Accelerate URL in browsers that need China acceleration; never commit it.',
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
