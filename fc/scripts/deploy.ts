/**
 * 用法: npx tsx fc/scripts/deploy.ts test|prod
 * 或: cd fc && ./scripts/deploy.sh test|prod（薄包装）
 *
 * 硬性规则：禁止让 `s deploy` 的 stdout/stderr 进终端或日志。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRl } from '../../scripts/lib/cli-prompt'
import {
  parseDotenvFile,
  readDotenvKey,
  upsertDotenvKey,
} from '../../scripts/lib/dotenv-file'
import {
  promptQqbotChannel,
  promptTelegramChannel,
  shouldSkipNotifyPrompt,
} from '../../scripts/lib/notify-prompt'
import { run, runDiscarded } from '../../scripts/lib/spawn'

const FC_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(FC_ROOT, '..')

const TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_USER_ID'] as const
const QQBOT_KEYS = [
  'QQBOT_APP_ID',
  'QQBOT_APP_SECRET',
  'QQBOT_USER_OPENID',
] as const

function applyEnvKeys(
  envFile: string,
  values: Record<string, string>,
): void {
  for (const [k, v] of Object.entries(values)) {
    process.env[k] = v
    upsertDotenvKey(envFile, k, v)
  }
}

async function resolveNotifyChannels(envFile: string): Promise<void> {
  // refresh-prod 已写好并探测过时跳过二次询问
  if (shouldSkipNotifyPrompt()) {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? ''
    const userId = process.env.TELEGRAM_USER_ID ?? ''
    if ((token || userId) && !(token && userId)) {
      console.error('If either TELEGRAM_* is set, both must be non-empty.')
      process.exit(1)
    }
    const appId = process.env.QQBOT_APP_ID ?? ''
    const appSecret = process.env.QQBOT_APP_SECRET ?? ''
    const openid = process.env.QQBOT_USER_OPENID ?? ''
    const qqAny = Boolean(appId || appSecret || openid)
    const qqAll = Boolean(appId && appSecret && openid)
    if (qqAny && !qqAll) {
      console.error(
        'If any QQBOT_* is set, QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID must all be non-empty.',
      )
      process.exit(1)
    }
    console.error(
      token
        ? 'TELEGRAM_* already set (skip prompt).'
        : 'Telegram notify disabled (both empty; skip prompt).',
    )
    console.error(
      qqAll
        ? 'QQBOT_* already set (skip prompt).'
        : 'QQ Bot notify disabled (all empty; skip prompt).',
    )
    return
  }

  const rl = createRl()
  try {
    const rootEnv = resolve(REPO_ROOT, '.env')
    const tg = await promptTelegramChannel(rl, {
      probeText: 'DigitalTwin2026 deploying',
      offerRepoEnv: {
        token: readDotenvKey(rootEnv, 'TELEGRAM_BOT_TOKEN'),
        userId: readDotenvKey(rootEnv, 'TELEGRAM_USER_ID'),
      },
    })
    applyEnvKeys(envFile, tg)
    console.error('')

    const qq = await promptQqbotChannel(rl, {
      probeText: 'DigitalTwin2026 deploying',
      offerRepoEnv: {
        appId: readDotenvKey(rootEnv, 'QQBOT_APP_ID'),
        appSecret: readDotenvKey(rootEnv, 'QQBOT_APP_SECRET'),
        userOpenid: readDotenvKey(rootEnv, 'QQBOT_USER_OPENID'),
      },
    })
    applyEnvKeys(envFile, qq)
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

  // 确保 skip 路径下缺失键视为空串（避免旧文件缺 QQBOT_*）
  for (const key of [...TELEGRAM_KEYS, ...QQBOT_KEYS]) {
    if (process.env[key] === undefined) process.env[key] = ''
  }

  await resolveNotifyChannels(envFile)

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
