import { describe, expect, it } from 'vitest'
import {
  PROMPT_DEPLOY_ALIYUN_FC,
  PROMPT_DEPLOY_TENCENT_SCF,
  PROMPT_DEPLOY_VERCEL,
  VERCEL_KEYS,
  anyDeployChosen,
  cloudDeployDecision,
  parseDeployTarget,
  USAGE,
} from './deploy'
import {
  DEFAULT_FC_FUNCTION_NAME,
  DEFAULT_SCF_FUNCTION_NAME,
  REQUIRED_COLLECT_KEYS,
  COLLECT_KEYS,
  emptyInputPolicy,
  resolveWithDefault,
  writeProdEnvFile,
} from './collect-prod-env'
import {
  channelEnableDecision,
  shouldSkipNotifyPrompt,
} from './lib/notify-prompt'
import { parseEnvFileArg, usageEnvFile } from './lib/env-file-arg'
import {
  SUPPRESS_BOT_NOTIFICATION,
  forcedSuppressBotNotificationValue,
  withForcedSuppressBotNotification,
} from './lib/suppress-bot-notification-deploy'
import { parseDotenvFile } from './lib/dotenv-file'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPTIONAL_KEYS as FC_OPTIONAL_KEYS,
  patchSyamlFunctionName,
} from '../faas/providers/aliyun-fc/scripts/deploy'
import {
  OPTIONAL_KEYS as SCF_OPTIONAL_KEYS,
  patchServerlessFunctionName,
} from '../faas/providers/tencent-scf/scripts/deploy'

describe('parseDeployTarget', () => {
  it('requires test|prod', () => {
    expect(parseDeployTarget([])).toBeNull()
    expect(parseDeployTarget(['staging'])).toBeNull()
    expect(parseDeployTarget(['test'])).toBe('test')
    expect(parseDeployTarget(['prod'])).toBe('prod')
  })
})

describe('USAGE', () => {
  it('is English and mentions test|prod; Vercel optional on prod', () => {
    expect(USAGE).toMatch(/test\|prod/)
    expect(USAGE).toMatch(/usage:/i)
    expect(USAGE).toMatch(/Ask Vercel\/FC\/SCF/i)
    expect(USAGE).not.toMatch(/Vercel required/i)
  })
})

describe('emptyInputPolicy (collect)', () => {
  it('rejects empty for required collect keys', () => {
    expect(REQUIRED_COLLECT_KEYS).toEqual([
      'DATABASE_URL',
      'DIGITAL_TWIN_TOKEN',
      'DIGITAL_TWIN_ADMIN_TOKEN',
      'FC_FUNCTION_NAME',
      'SCF_FUNCTION_NAME',
    ])
    for (const key of REQUIRED_COLLECT_KEYS) {
      expect(emptyInputPolicy(key)).toBe('reject')
    }
  })

  it('skips empty for notify keys', () => {
    expect(emptyInputPolicy('TELEGRAM_BOT_TOKEN')).toBe('skip')
    expect(emptyInputPolicy('QQBOT_APP_ID')).toBe('skip')
  })
})

describe('function name defaults', () => {
  it('defaults to digitaltwin-api-prod; empty input keeps default', () => {
    expect(DEFAULT_FC_FUNCTION_NAME).toBe('digitaltwin-api-prod')
    expect(DEFAULT_SCF_FUNCTION_NAME).toBe('digitaltwin-api-prod')
    expect(resolveWithDefault('', DEFAULT_FC_FUNCTION_NAME)).toBe(
      'digitaltwin-api-prod',
    )
    expect(resolveWithDefault('  ', DEFAULT_SCF_FUNCTION_NAME)).toBe(
      'digitaltwin-api-prod',
    )
    expect(resolveWithDefault('my-fn', DEFAULT_FC_FUNCTION_NAME)).toBe('my-fn')
  })
})

describe('channelEnableDecision', () => {
  it('defaults to disable; y/yes enable', () => {
    expect(channelEnableDecision('')).toBe('disable')
    expect(channelEnableDecision('n')).toBe('disable')
    expect(channelEnableDecision('y')).toBe('enable')
    expect(channelEnableDecision('YES')).toBe('enable')
  })
})

describe('cloudDeployDecision', () => {
  it('defaults to skip; only y/yes deploy', () => {
    expect(cloudDeployDecision('')).toBe('skip')
    expect(cloudDeployDecision('n')).toBe('skip')
    expect(cloudDeployDecision('y')).toBe('deploy')
    expect(cloudDeployDecision('YES')).toBe('deploy')
  })
})

describe('optional cloud prompt strings', () => {
  it('matches deploy UX (default N for Vercel/FC/SCF)', () => {
    expect(PROMPT_DEPLOY_VERCEL).toBe('Deploy Vercel production? [y/N] ')
    expect(PROMPT_DEPLOY_ALIYUN_FC).toBe('Deploy Aliyun FC? [y/N] ')
    expect(PROMPT_DEPLOY_TENCENT_SCF).toBe('Deploy Tencent SCF? [y/N] ')
  })
})

describe('anyDeployChosen', () => {
  it('is false when all skipped; true if any target selected', () => {
    expect(
      anyDeployChosen({ vercel: false, fc: false, scf: false }),
    ).toBe(false)
    expect(anyDeployChosen({ vercel: true, fc: false, scf: false })).toBe(true)
    expect(anyDeployChosen({ vercel: false, fc: true, scf: false })).toBe(true)
    expect(anyDeployChosen({ vercel: false, fc: false, scf: true })).toBe(true)
  })
})

describe('shouldSkipNotifyPrompt', () => {
  it('accepts DT_SKIP_NOTIFY_PROMPT or legacy DT_SKIP_TELEGRAM_PROMPT', () => {
    expect(shouldSkipNotifyPrompt({})).toBe(false)
    expect(shouldSkipNotifyPrompt({ DT_SKIP_NOTIFY_PROMPT: '1' })).toBe(true)
    expect(shouldSkipNotifyPrompt({ DT_SKIP_TELEGRAM_PROMPT: '1' })).toBe(true)
  })
})

describe('parseEnvFileArg', () => {
  it('reads --env-file and ENV_FILE', () => {
    expect(parseEnvFileArg(['--env-file', '/tmp/a.env'], {})).toBe('/tmp/a.env')
    expect(parseEnvFileArg(['--env-file=/tmp/b.env'], {})).toBe('/tmp/b.env')
    expect(parseEnvFileArg([], { ENV_FILE: '/tmp/c.env' })).toBe('/tmp/c.env')
    expect(parseEnvFileArg([], {})).toBeNull()
    expect(usageEnvFile('deploy.ts')).toMatch(/--env-file/)
  })
})

describe('function name overlays', () => {
  it('patches FC s.yaml functionName', () => {
    const src = 'props:\n      functionName: digitaltwin-api-test\n'
    expect(patchSyamlFunctionName(src, 'digitaltwin-api-prod')).toContain(
      'functionName: digitaltwin-api-prod',
    )
  })

  it('patches SCF serverless.yml name', () => {
    const src = 'inputs:\n  name: digitaltwin-api-${stage}\n  type: web\n'
    expect(patchServerlessFunctionName(src, 'digitaltwin-api-prod')).toContain(
      'name: digitaltwin-api-prod',
    )
  })
})

describe('SUPPRESS_BOT_NOTIFICATION deploy injection (stage 2)', () => {
  it('forces test=1 and prod=0; overrides mistaken values', () => {
    expect(forcedSuppressBotNotificationValue('test')).toBe('1')
    expect(forcedSuppressBotNotificationValue('prod')).toBe('0')
    expect(
      withForcedSuppressBotNotification(
        { SUPPRESS_BOT_NOTIFICATION: '0', X: '1' },
        'test',
      ),
    ).toEqual({ SUPPRESS_BOT_NOTIFICATION: '1', X: '1' })
    expect(
      withForcedSuppressBotNotification(
        { SUPPRESS_BOT_NOTIFICATION: '1', X: '1' },
        'prod',
      ),
    ).toEqual({ SUPPRESS_BOT_NOTIFICATION: '0', X: '1' })
  })

  it('whitelists the key on FC / SCF / Vercel (always present)', () => {
    expect(FC_OPTIONAL_KEYS).toContain(SUPPRESS_BOT_NOTIFICATION)
    expect(SCF_OPTIONAL_KEYS).toContain(SUPPRESS_BOT_NOTIFICATION)
    expect(VERCEL_KEYS).toContain(SUPPRESS_BOT_NOTIFICATION)
  })

  it('collect does not prompt for SUPPRESS (not in COLLECT_KEYS)', () => {
    expect(COLLECT_KEYS).not.toContain(SUPPRESS_BOT_NOTIFICATION)
  })

  it('writeProdEnvFile always writes SUPPRESS=0 even if source had 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dt-collect-suppress-'))
    const dest = join(dir, '.env.prod')
    try {
      writeProdEnvFile(
        {
          DATABASE_URL: 'postgres://x',
          SUPPRESS_BOT_NOTIFICATION: '1',
        },
        dest,
      )
      const parsed = parseDotenvFile(dest)
      expect(parsed.SUPPRESS_BOT_NOTIFICATION).toBe('0')
      expect(parsed.DATABASE_URL).toBe('postgres://x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
