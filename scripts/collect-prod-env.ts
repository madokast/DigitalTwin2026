/**
 * 独立子过程：stdin 收集全部生产密钥 → 写根目录临时 `.env.prod`（mode 0600）。
 *
 * 默认由 `npm run deploy -- prod` 调用；单独跑时调用方须负责删除 `.env.prod`。
 * 用户可见文案英文；勿把密钥提交 git。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Interface as ReadlineInterface } from 'node:readline'
import {
  askLine,
  askSecret,
  createRl,
  isYes,
  trimInput,
} from './lib/cli-prompt'
import { parseDotenvFile, writeFcEnvFile } from './lib/dotenv-file'
import { maskValue } from './lib/mask'
import {
  promptQqbotChannel,
  promptTelegramChannel,
} from './lib/notify-prompt'
import { PROD_ENV_FILE, TEST_ENV_FILE } from './lib/test-env'
import { verifyDatabaseUrl } from './lib/verify-database'

export const COLLECT_KEYS = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_USER_ID',
  'QQBOT_APP_ID',
  'QQBOT_APP_SECRET',
  'QQBOT_USER_OPENID',
  'FC_FUNCTION_NAME',
  'SCF_FUNCTION_NAME',
] as const

export type CollectKey = (typeof COLLECT_KEYS)[number]

export const REQUIRED_COLLECT_KEYS: CollectKey[] = [
  'DATABASE_URL',
  'DIGITAL_TWIN_TOKEN',
  'DIGITAL_TWIN_ADMIN_TOKEN',
  'FC_FUNCTION_NAME',
  'SCF_FUNCTION_NAME',
]

/** 空输入：必填拒绝；通知渠道由 Enable 流程处理 */
export function emptyInputPolicy(key: CollectKey): 'reject' | 'skip' {
  if (REQUIRED_COLLECT_KEYS.includes(key)) return 'reject'
  return 'skip'
}

async function promptRequired(
  rl: ReadlineInterface,
  key: CollectKey,
): Promise<string> {
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
      return val
    }
    console.error('Try again.')
  }
}

/** 非密钥：可见输入；回车采用 defaultValue，可改 */
export function resolveWithDefault(raw: string, defaultValue: string): string {
  const val = trimInput(raw)
  return val || defaultValue
}

export async function promptWithDefault(
  rl: ReadlineInterface,
  key: CollectKey,
  defaultValue: string,
): Promise<string> {
  const raw = await askLine(rl, `${key} [${defaultValue}]: `)
  return resolveWithDefault(raw, defaultValue)
}

export const DEFAULT_FC_FUNCTION_NAME = 'digitaltwin-api-prod'
export const DEFAULT_SCF_FUNCTION_NAME = 'digitaltwin-api-prod'

const PROBE_TEXT = 'DigitalTwin2026 prod env verify'

/** 仅当 `.env.test` 存在时返回 bot offer（给 Enable=Y 后询问是否复用） */
export function readBotOffersFromTestEnv(
  testEnvPath: string,
  io: {
    existsSync?: (path: string) => boolean
    parseDotenvFile?: (path: string) => Record<string, string>
  } = {},
): {
  telegram?: { token: string; userId: string }
  qqbot?: { appId: string; appSecret: string; userOpenid: string }
} {
  const exists = io.existsSync ?? existsSync
  const parse = io.parseDotenvFile ?? parseDotenvFile
  if (!exists(testEnvPath)) return {}
  const env = parse(testEnvPath)
  return {
    telegram: {
      token: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
      userId: (env.TELEGRAM_USER_ID ?? '').trim(),
    },
    qqbot: {
      appId: (env.QQBOT_APP_ID ?? '').trim(),
      appSecret: (env.QQBOT_APP_SECRET ?? '').trim(),
      userOpenid: (env.QQBOT_USER_OPENID ?? '').trim(),
    },
  }
}

export async function collectProdEnvValues(
  rl: ReadlineInterface,
): Promise<Record<CollectKey, string>> {
  const values = {} as Record<CollectKey, string>

  for (const key of [
    'DATABASE_URL',
    'DIGITAL_TWIN_TOKEN',
    'DIGITAL_TWIN_ADMIN_TOKEN',
  ] as const) {
    values[key] = await promptRequired(rl, key)
    console.log('')
  }

  // Bot 敏感度低：可选复用 `.env.test` 中对应键写入 `.env.prod`（非整文件）
  const botOffers = readBotOffersFromTestEnv(TEST_ENV_FILE)

  console.log('--- Notify channels ---')
  const tg = await promptTelegramChannel(rl, {
    probeText: PROBE_TEXT,
    ...(botOffers.telegram ? { offerRepoEnv: botOffers.telegram } : {}),
  })
  values.TELEGRAM_BOT_TOKEN = tg.TELEGRAM_BOT_TOKEN
  values.TELEGRAM_USER_ID = tg.TELEGRAM_USER_ID
  console.log('')

  const qq = await promptQqbotChannel(rl, {
    probeText: PROBE_TEXT,
    ...(botOffers.qqbot ? { offerRepoEnv: botOffers.qqbot } : {}),
  })
  values.QQBOT_APP_ID = qq.QQBOT_APP_ID
  values.QQBOT_APP_SECRET = qq.QQBOT_APP_SECRET
  values.QQBOT_USER_OPENID = qq.QQBOT_USER_OPENID
  console.log('')

  console.log('--- FaaS function names ---')
  values.FC_FUNCTION_NAME = await promptWithDefault(
    rl,
    'FC_FUNCTION_NAME',
    DEFAULT_FC_FUNCTION_NAME,
  )
  console.log('')
  values.SCF_FUNCTION_NAME = await promptWithDefault(
    rl,
    'SCF_FUNCTION_NAME',
    DEFAULT_SCF_FUNCTION_NAME,
  )
  console.log('')

  return values
}

export function writeProdEnvFile(
  values: Record<string, string>,
  dest: string = PROD_ENV_FILE,
): string {
  writeFcEnvFile(dest, values)
  return dest
}

async function main(): Promise<void> {
  console.log('=== Collect production secrets → temporary .env.prod ===')
  console.log('Do NOT commit these values to git or paste in chat logs.')
  console.log('Flow:')
  console.log(
    '  - DATABASE_URL / DIGITAL_TWIN_TOKEN / DIGITAL_TWIN_ADMIN_TOKEN: required',
  )
  console.log(
    '  - Enable Telegram / QQ? [y/N] → N writes empty; Y: if .env.test exists ask reuse bot keys, else fill + probe',
  )
  console.log(
    '  - FC_FUNCTION_NAME / SCF_FUNCTION_NAME: default digitaltwin-api-prod (Enter to keep)',
  )
  console.log('  - Writes repo-root .env.prod (mode 0600)')
  console.log('')

  if (existsSync(PROD_ENV_FILE)) {
    console.error(
      `Refusing to overwrite existing ${PROD_ENV_FILE}. Delete it first (or finish a previous deploy prod).`,
    )
    process.exit(1)
  }

  const rl = createRl()
  let values: Record<CollectKey, string>
  try {
    values = await collectProdEnvValues(rl)
  } finally {
    rl.close()
  }

  for (const key of REQUIRED_COLLECT_KEYS) {
    if (!values[key]) {
      console.error(`Missing required ${key}`)
      process.exit(1)
    }
  }

  console.log('Summary (masked):')
  for (const key of COLLECT_KEYS) {
    console.log(
      values[key]
        ? `  ${key}: ${maskValue(values[key])}`
        : `  ${key}: (empty)`,
    )
  }

  const dest = writeProdEnvFile(values)
  console.log(`Wrote ${resolve(dest)} (mode 0600)`)
  console.log(
    'Prefer running via: npm run deploy -- prod (deletes .env.prod on exit).',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
