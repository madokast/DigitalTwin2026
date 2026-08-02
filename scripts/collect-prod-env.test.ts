import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Interface as ReadlineInterface } from 'node:readline'

vi.mock('./lib/cli-prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/cli-prompt')>()
  return {
    ...actual,
    askLine: vi.fn(),
  }
})

import { askLine } from './lib/cli-prompt'
import {
  PROMPT_RUN_DB_MIGRATE,
  dbMigrateDecision,
  promptDbMigrateIfNeeded,
  readBotOffersFromTestEnv,
  runDbMigrate,
} from './collect-prod-env'

const rl = {} as ReadlineInterface

beforeEach(() => {
  vi.mocked(askLine).mockReset()
})

describe('readBotOffersFromTestEnv', () => {
  it('returns empty offers when .env.test does not exist', () => {
    expect(
      readBotOffersFromTestEnv('/no/such/.env.test', {
        existsSync: () => false,
        parseDotenvFile: () => {
          throw new Error('should not parse')
        },
      }),
    ).toEqual({})
  })

  it('reads only Telegram / QQ bot keys when .env.test exists', () => {
    const offers = readBotOffersFromTestEnv('/repo/.env.test', {
      existsSync: () => true,
      parseDotenvFile: () => ({
        DATABASE_URL: 'postgres://secret',
        DIGITAL_TWIN_TOKEN: 'twin',
        TELEGRAM_BOT_TOKEN: '  tg-tok  ',
        TELEGRAM_USER_ID: '123',
        QQBOT_APP_ID: 'qid',
        QQBOT_APP_SECRET: 'qsec',
        QQBOT_USER_OPENID: 'openid',
        FC_FUNCTION_NAME: 'fn',
      }),
    })
    expect(offers).toEqual({
      telegram: { token: 'tg-tok', userId: '123' },
      qqbot: {
        appId: 'qid',
        appSecret: 'qsec',
        userOpenid: 'openid',
      },
    })
    // 非 bot 键不得出现在 offer 结构中
    expect(offers).not.toHaveProperty('DATABASE_URL')
  })

  it('still offers objects when bot keys are missing (caller may fall through)', () => {
    expect(
      readBotOffersFromTestEnv('/repo/.env.test', {
        existsSync: () => true,
        parseDotenvFile: () => ({ DATABASE_URL: 'x' }),
      }),
    ).toEqual({
      telegram: { token: '', userId: '' },
      qqbot: { appId: '', appSecret: '', userOpenid: '' },
    })
  })
})

describe('dbMigrateDecision', () => {
  it('defaults to skip; only y/yes run', () => {
    expect(dbMigrateDecision('')).toBe('skip')
    expect(dbMigrateDecision('n')).toBe('skip')
    expect(dbMigrateDecision('N')).toBe('skip')
    expect(dbMigrateDecision('y')).toBe('run')
    expect(dbMigrateDecision('YES')).toBe('run')
  })
})

describe('PROMPT_RUN_DB_MIGRATE', () => {
  it('is English default-N prompt for drizzle-kit migrate', () => {
    expect(PROMPT_RUN_DB_MIGRATE).toBe(
      'Run drizzle-kit migrate on this database? [y/N] ',
    )
  })
})

describe('promptDbMigrateIfNeeded', () => {
  it('N / Enter → skip migrate (do not call runMigrate)', async () => {
    const runMigrate = vi.fn()
    vi.mocked(askLine).mockResolvedValueOnce('')

    await expect(
      promptDbMigrateIfNeeded(rl, 'postgres://verified', { runMigrate }),
    ).resolves.toBe('skipped')

    expect(askLine).toHaveBeenCalledWith(rl, PROMPT_RUN_DB_MIGRATE)
    expect(runMigrate).not.toHaveBeenCalled()
  })

  it('Y → run migrate with verified DATABASE_URL', async () => {
    const runMigrate = vi.fn()
    vi.mocked(askLine).mockResolvedValueOnce('y')

    await expect(
      promptDbMigrateIfNeeded(rl, 'postgres://verified', { runMigrate }),
    ).resolves.toBe('ran')

    expect(runMigrate).toHaveBeenCalledTimes(1)
    expect(runMigrate).toHaveBeenCalledWith('postgres://verified')
  })

  it('Y + migrate failure → throws English error (abort collect)', async () => {
    const runMigrate = vi.fn(() => {
      throw new Error(
        'drizzle-kit migrate failed. Fix the database and re-run collect-prod-env.',
      )
    })
    vi.mocked(askLine).mockResolvedValueOnce('y')

    await expect(
      promptDbMigrateIfNeeded(rl, 'postgres://verified', { runMigrate }),
    ).rejects.toThrow(/drizzle-kit migrate failed/i)
  })
})

describe('runDbMigrate', () => {
  it('runs npm run db:migrate with DATABASE_URL in child env (does not print URL)', () => {
    const run = vi.fn(() => 0)
    runDbMigrate('postgres://secret-prod-url', { run })

    expect(run).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = run.mock.calls[0]!
    expect(cmd).toBe('npm')
    expect(args).toEqual(['run', 'db:migrate'])
    expect(opts.env?.DATABASE_URL).toBe('postgres://secret-prod-url')
  })

  it('non-zero exit → throws English error', () => {
    const run = vi.fn(() => 1)
    expect(() =>
      runDbMigrate('postgres://secret-prod-url', { run }),
    ).toThrow(/drizzle-kit migrate failed/i)
  })
})
