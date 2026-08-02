import { describe, expect, it } from 'vitest'
import { readBotOffersFromTestEnv } from './collect-prod-env'

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
