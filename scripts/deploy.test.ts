import { describe, expect, it } from 'vitest'
import {
  PROMPT_DEPLOY_ALIYUN_FC,
  PROMPT_DEPLOY_TENCENT_SCF,
  cloudDeployDecision,
  parseDeployTarget,
  USAGE,
} from './deploy'
import {
  REQUIRED_COLLECT_KEYS,
  emptyInputPolicy,
} from './collect-prod-env'
import {
  channelEnableDecision,
  shouldSkipNotifyPrompt,
} from './lib/notify-prompt'
import { parseEnvFileArg, usageEnvFile } from './lib/env-file-arg'
import { patchSyamlFunctionName } from '../faas/providers/aliyun-fc/scripts/deploy'
import { patchServerlessFunctionName } from '../faas/providers/tencent-scf/scripts/deploy'

describe('parseDeployTarget', () => {
  it('requires test|prod', () => {
    expect(parseDeployTarget([])).toBeNull()
    expect(parseDeployTarget(['staging'])).toBeNull()
    expect(parseDeployTarget(['test'])).toBe('test')
    expect(parseDeployTarget(['prod'])).toBe('prod')
  })
})

describe('USAGE', () => {
  it('is English and mentions test|prod', () => {
    expect(USAGE).toMatch(/test\|prod/)
    expect(USAGE).toMatch(/usage:/i)
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

describe('optional FaaS prompt strings', () => {
  it('matches deploy UX (default N; no test/prod in prompt)', () => {
    expect(PROMPT_DEPLOY_ALIYUN_FC).toBe('Deploy Aliyun FC? [y/N] ')
    expect(PROMPT_DEPLOY_TENCENT_SCF).toBe('Deploy Tencent SCF? [y/N] ')
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
