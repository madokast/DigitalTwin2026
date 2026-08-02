/**
 * 部署/刷新脚本共用的通知渠道 enable 判定与跳过开关。
 * 用户可见文案英文；不打印 token/secret。
 */
import type { Interface as ReadlineInterface } from 'node:readline'
import { askLine, askSecret, isYes, trimInput } from './cli-prompt'
import { maskValue } from './mask'
import { qqbotProbeSend } from './qqbot-probe'
import { telegramProbeSend } from './telegram-probe'

/** Enable? [y/N] → enable | disable（默认 N） */
export function channelEnableDecision(ans: string): 'enable' | 'disable' {
  return isYes(ans) ? 'enable' : 'disable'
}

/** deploy 已写好 env（DT_SKIP_NOTIFY_PROMPT=1）时跳过全部渠道询问；兼容旧名 DT_SKIP_TELEGRAM_PROMPT */
export function shouldSkipNotifyPrompt(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.DT_SKIP_NOTIFY_PROMPT === '1' || env.DT_SKIP_TELEGRAM_PROMPT === '1'
  )
}

async function askRequiredSecret(
  rl: ReadlineInterface,
  key: string,
): Promise<string> {
  for (;;) {
    const val = trimInput(await askSecret(rl, `Enter ${key} (required): `))
    if (!val) {
      console.error(`  ${key} cannot be empty. Please enter a value.`)
      console.error('')
      continue
    }
    console.error(`  Preview: ${maskValue(val)}`)
    if (isYes(await askLine(rl, 'Confirm? [y/N] '))) {
      return val
    }
    console.error('Try again.')
  }
}

export type TelegramChannelValues = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_USER_ID: string
}

export type QqbotChannelValues = {
  QQBOT_APP_ID: string
  QQBOT_APP_SECRET: string
  QQBOT_USER_OPENID: string
}

/**
 * Enable Telegram？N→双空；Y→必填并探测。
 * @param probeText 探测文案（如 prod verify / deploying）
 * @param offerRepoEnv Enable=Y 时是否询问「Use from repo .env.test?」
 */
export async function promptTelegramChannel(
  rl: ReadlineInterface,
  options: {
    probeText: string
    offerRepoEnv?: { token: string; userId: string }
  },
): Promise<TelegramChannelValues> {
  for (;;) {
    const ans = await askLine(rl, 'Enable Telegram notify? [y/N] ')
    if (channelEnableDecision(ans) === 'disable') {
      console.error('Telegram notify disabled (both keys set empty).')
      return { TELEGRAM_BOT_TOKEN: '', TELEGRAM_USER_ID: '' }
    }

    let token = ''
    let userId = ''
    const offer = options.offerRepoEnv
    if (offer) {
      const useAns = await askLine(rl, 'Use TELEGRAM_* from repo .env.test? [Y/n] ')
      const useRoot = !(
        useAns.trim().toLowerCase() === 'n' ||
        useAns.trim().toLowerCase() === 'no'
      )
      if (useRoot) {
        if (offer.token && offer.userId) {
          token = offer.token
          userId = offer.userId
          console.error('Using TELEGRAM_* from repo .env.test.')
        } else {
          console.error(
            'Repo .env.test TELEGRAM_* incomplete or missing; fall through to manual entry.',
          )
        }
      }
    }

    if (!token || !userId) {
      token = await askRequiredSecret(rl, 'TELEGRAM_BOT_TOKEN')
      userId = await askRequiredSecret(rl, 'TELEGRAM_USER_ID')
    }

    console.error(`Verifying Telegram sendMessage (${options.probeText})...`)
    const err = await telegramProbeSend(token, userId, options.probeText)
    if (err) {
      console.error(err)
      console.error('Telegram verify failed. Please re-enter credentials.')
      console.error('')
      continue
    }
    console.error('ok: Telegram message sent')
    return { TELEGRAM_BOT_TOKEN: token, TELEGRAM_USER_ID: userId }
  }
}

/**
 * Enable QQ Bot？N→三空；Y→必填并主动 C2C 探测。
 */
export async function promptQqbotChannel(
  rl: ReadlineInterface,
  options: {
    probeText: string
    offerRepoEnv?: {
      appId: string
      appSecret: string
      userOpenid: string
    }
  },
): Promise<QqbotChannelValues> {
  for (;;) {
    const ans = await askLine(rl, 'Enable QQ Bot notify? [y/N] ')
    if (channelEnableDecision(ans) === 'disable') {
      console.error('QQ Bot notify disabled (all three keys set empty).')
      return {
        QQBOT_APP_ID: '',
        QQBOT_APP_SECRET: '',
        QQBOT_USER_OPENID: '',
      }
    }

    let appId = ''
    let appSecret = ''
    let userOpenid = ''
    const offer = options.offerRepoEnv
    if (offer) {
      const useAns = await askLine(rl, 'Use QQBOT_* from repo .env.test? [Y/n] ')
      const useRoot = !(
        useAns.trim().toLowerCase() === 'n' ||
        useAns.trim().toLowerCase() === 'no'
      )
      if (useRoot) {
        if (offer.appId && offer.appSecret && offer.userOpenid) {
          appId = offer.appId
          appSecret = offer.appSecret
          userOpenid = offer.userOpenid
          console.error('Using QQBOT_* from repo .env.test.')
        } else {
          console.error(
            'Repo .env.test QQBOT_* incomplete or missing; fall through to manual entry.',
          )
        }
      }
    }

    if (!appId || !appSecret || !userOpenid) {
      appId = await askRequiredSecret(rl, 'QQBOT_APP_ID')
      appSecret = await askRequiredSecret(rl, 'QQBOT_APP_SECRET')
      userOpenid = await askRequiredSecret(rl, 'QQBOT_USER_OPENID')
    }

    console.error(`Verifying QQ Bot C2C send (${options.probeText})...`)
    const err = await qqbotProbeSend(
      appId,
      appSecret,
      userOpenid,
      options.probeText,
    )
    if (err) {
      console.error(err)
      console.error('QQ Bot verify failed. Please re-enter credentials.')
      console.error('')
      continue
    }
    console.error('ok: QQ Bot message sent')
    return {
      QQBOT_APP_ID: appId,
      QQBOT_APP_SECRET: appSecret,
      QQBOT_USER_OPENID: userOpenid,
    }
  }
}
