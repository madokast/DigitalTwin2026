/**
 * 用法: npx tsx fc/scripts/deploy.ts test|prod
 * 或: cd fc && ./scripts/deploy.sh test|prod（薄包装）
 *
 * 硬性规则：禁止让 `s deploy` 的 stdout/stderr 进终端或日志。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  askLine,
  createRl,
  trimInput,
} from '../../scripts/lib/cli-prompt'
import {
  parseDotenvFile,
  readDotenvKey,
  upsertDotenvKey,
} from '../../scripts/lib/dotenv-file'
import { run, runDiscarded } from '../../scripts/lib/spawn'
import { telegramProbeSend } from '../../scripts/lib/telegram-probe'

const FC_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(FC_ROOT, '..')

async function resolveTelegramIfNeeded(envFile: string): Promise<void> {
  // refresh-prod 已写好并探测过时跳过二次询问
  if (process.env.DT_SKIP_TELEGRAM_PROMPT === '1') {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? ''
    const userId = process.env.TELEGRAM_USER_ID ?? ''
    if ((token || userId) && !(token && userId)) {
      console.error('If either TELEGRAM_* is set, both must be non-empty.')
      process.exit(1)
    }
    console.error(
      token
        ? 'TELEGRAM_* already set (skip prompt).'
        : 'Telegram notify disabled (both empty; skip prompt).',
    )
    return
  }
  await resolveTelegramEnv(envFile)
}

async function resolveTelegramEnv(envFile: string): Promise<void> {
  const rl = createRl()
  try {
    const rootEnv = resolve(REPO_ROOT, '.env')
    const rootToken = readDotenvKey(rootEnv, 'TELEGRAM_BOT_TOKEN')
    const rootUid = readDotenvKey(rootEnv, 'TELEGRAM_USER_ID')

    const ans = await askLine(rl, 'Use TELEGRAM_* from repo .env? [Y/n] ')
    const useRoot = !(
      ans.trim().toLowerCase() === 'n' || ans.trim().toLowerCase() === 'no'
    )

    let token = ''
    let userId = ''
    if (useRoot) {
      if (rootToken && rootUid) {
        token = rootToken
        userId = rootUid
        console.error('Using TELEGRAM_* from repo .env.')
      } else {
        console.error(
          'Repo .env TELEGRAM_* incomplete or missing; fall through to manual entry.',
        )
      }
    }

    if (!token || !userId) {
      token = trimInput(
        await askLine(rl, 'TELEGRAM_BOT_TOKEN (empty to disable notify): '),
      )
      userId = trimInput(
        await askLine(rl, 'TELEGRAM_USER_ID (empty to disable notify): '),
      )
    }

    if (!token && !userId) {
      console.error('Telegram notify disabled for this deploy (both empty).')
      process.env.TELEGRAM_BOT_TOKEN = ''
      process.env.TELEGRAM_USER_ID = ''
      upsertDotenvKey(envFile, 'TELEGRAM_BOT_TOKEN', '')
      upsertDotenvKey(envFile, 'TELEGRAM_USER_ID', '')
      return
    }

    if (!token || !userId) {
      console.error('If either TELEGRAM_* is set, both must be non-empty.')
      process.exit(1)
    }

    console.error(
      'Probing Telegram with sendMessage (DigitalTwin2026 deploying)...',
    )
    const err = await telegramProbeSend(
      token,
      userId,
      'DigitalTwin2026 deploying',
    )
    if (err) {
      console.error(err)
      console.error('Telegram probe failed — fix credentials and re-run deploy.')
      process.exit(1)
    }
    console.error('Telegram probe OK.')

    process.env.TELEGRAM_BOT_TOKEN = token
    process.env.TELEGRAM_USER_ID = userId
    upsertDotenvKey(envFile, 'TELEGRAM_BOT_TOKEN', token)
    upsertDotenvKey(envFile, 'TELEGRAM_USER_ID', userId)
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const envName = process.argv[2] ?? ''
  if (envName !== 'test' && envName !== 'prod') {
    console.error('usage: deploy.ts test|prod')
    process.exit(1)
  }

  const envFile = resolve(FC_ROOT, `.env.fc.${envName}`)
  if (!existsSync(envFile)) {
    console.error(
      `missing ${envFile} — copy from env.fc.example and fill secrets`,
    )
    process.exit(1)
  }

  const loaded = parseDotenvFile(envFile)
  for (const [k, v] of Object.entries(loaded)) {
    process.env[k] = v
  }

  for (const key of [
    'DATABASE_URL',
    'DIGITAL_TWIN_TOKEN',
    'DIGITAL_TWIN_ADMIN_TOKEN',
  ] as const) {
    if (!process.env[key]) {
      console.error(`${key} required in ${envFile}`)
      process.exit(1)
    }
  }

  await resolveTelegramIfNeeded(envFile)

  console.log(
    `deploying env=${envName} (s deploy output discarded — secrets must not print)`,
  )
  const status = runDiscarded('s', ['deploy', '--env', envName, '-y'], {
    cwd: FC_ROOT,
    env: process.env,
  })
  if (status !== 0) {
    console.error(
      `deploy FAILED (env=${envName}). Re-run only via this script; do not run bare s deploy.`,
    )
    process.exit(1)
  }

  console.log('deploy OK.')
  const info = run('bash', [resolve(FC_ROOT, 'scripts/info.sh'), envName], {
    cwd: FC_ROOT,
    env: process.env,
  })
  const url = info.stdout.trim()
  if (url) {
    console.log(`HTTP Base URL: ${url}`)
    console.log('Paste into Settings → API Accelerate URL (never commit).')
  } else {
    console.log(`Get HTTP URL with: ./scripts/info.sh ${envName}`)
  }
  console.log('Do NOT run: s deploy   (leaks env secrets to the terminal)')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
