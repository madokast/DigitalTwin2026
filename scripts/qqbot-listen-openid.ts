/**
 * 监听 QQ 机器人私聊事件，打印对方 user_openid，并回发一条英文确认消息。
 * 不打印 AppSecret / access_token。
 *
 * 用法（仓库根）: npm run qqbot:listen-openid
 * 需在 .env.test 配置 QQBOT_APP_ID、QQBOT_APP_SECRET。
 * 先启动本脚本，再给机器人发一条私聊（历史消息不会回放）。
 */
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { readDotenvKey } from './lib/dotenv-file'
import { TEST_ENV_FILE } from './lib/test-env'

const ENV_FILE = TEST_ENV_FILE

const INTENT_GROUP_AND_C2C = 1 << 25
const DEFAULT_TIMEOUT_MS = 120_000
const API_BASES = [
  'https://api.sgroup.qq.com',
  'https://api.bot.qq.com',
] as const

type GatewayHello = { op: number; d?: { heartbeat_interval?: number } }
type GatewayEvent = {
  op: number
  s?: number
  t?: string
  d?: {
    id?: string
    author?: {
      user_openid?: string
      member_openid?: string
      id?: string
    }
    content?: string
  }
}

type ListenResult = {
  openid: string
  msgId: string
  close: () => void
}

async function getAccessToken(
  appId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
  })
  const body = (await res.json()) as {
    access_token?: string
    expires_in?: number
    message?: string
    msg?: string
  }
  if (!body.access_token) {
    throw new Error(
      `getAppAccessToken failed: ${body.message || body.msg || `HTTP ${res.status}`}`,
    )
  }
  console.error(
    `access_token ok (expires_in=${body.expires_in ?? 'unknown'}s)`,
  )
  return body.access_token
}

async function getGatewayUrl(accessToken: string): Promise<string> {
  for (const base of API_BASES) {
    for (const path of ['/gateway', '/gateway/bot'] as const) {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `QQBot ${accessToken}` },
      })
      const body = (await res.json()) as { url?: string }
      if (body.url) return body.url
    }
  }
  throw new Error('Could not resolve QQ Bot WebSocket gateway URL')
}

function parseTimeoutMs(): number {
  const raw = process.env.QQBOT_LISTEN_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 5_000) {
    throw new Error('QQBOT_LISTEN_TIMEOUT_MS must be a number >= 5000')
  }
  return Math.floor(n)
}

/** 被动回复（带 msg_id）更易成功；失败时返回英文错误（不含 token） */
async function sendC2cText(opts: {
  accessToken: string
  userOpenid: string
  text: string
  msgId: string
}): Promise<void> {
  const path = `/v2/users/${encodeURIComponent(opts.userOpenid)}/messages`
  const payload = {
    content: opts.text,
    msg_type: 0,
    msg_id: opts.msgId,
  }
  let lastErr = 'send failed'
  for (const base of API_BASES) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${opts.accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    const raw = await res.text()
    let body: { id?: string; message?: string; msg?: string; code?: number } =
      {}
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      /* non-json */
    }
    if (res.ok) {
      console.error(`probe message sent (HTTP ${res.status})`)
      return
    }
    lastErr =
      body.message ||
      body.msg ||
      (body.code != null ? `code ${body.code}` : `HTTP ${res.status}`)
    console.error(`send via ${base} failed: ${lastErr}`)
  }
  throw new Error(`C2C sendMessage failed: ${lastErr}`)
}

async function listenForUserOpenid(
  gatewayUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<ListenResult> {
  console.error(`WS: ${gatewayUrl}`)
  console.error(
    `Listening up to ${Math.round(timeoutMs / 1000)}s for C2C_MESSAGE_CREATE...`,
  )
  console.error('>>> Send a private message to the QQ bot now.')

  return new Promise((resolveListen, reject) => {
    let latestSeq: number | null = null
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let settled = false
    const ws = new WebSocket(gatewayUrl)

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup(true)
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for a private message`,
        ),
      )
    }, timeoutMs)

    function cleanup(closeSocket: boolean) {
      clearTimeout(timeout)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (closeSocket) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }

    ws.addEventListener('open', () => console.error('WS open'))
    ws.addEventListener('error', (ev) => {
      if (settled) return
      settled = true
      cleanup(true)
      reject(
        ev instanceof ErrorEvent && ev.error
          ? ev.error
          : new Error('WebSocket error'),
      )
    })
    ws.addEventListener('close', (ev) => {
      console.error(`WS close code=${ev.code}`)
    })

    ws.addEventListener('message', (ev) => {
      let msg: GatewayHello & GatewayEvent
      try {
        msg = JSON.parse(String(ev.data)) as GatewayHello & GatewayEvent
      } catch {
        return
      }
      if (typeof msg.s === 'number') latestSeq = msg.s

      if (msg.op === 10) {
        const interval = msg.d?.heartbeat_interval ?? 45_000
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${accessToken}`,
              intents: INTENT_GROUP_AND_C2C,
              shard: [0, 1],
              properties: {
                $os: 'linux',
                $browser: 'digitaltwin-qqbot-openid',
                $device: 'digitaltwin-qqbot-openid',
              },
            },
          }),
        )
        heartbeatTimer = setInterval(() => {
          ws.send(JSON.stringify({ op: 1, d: latestSeq }))
        }, interval)
        console.error(
          `Identify sent (GROUP_AND_C2C_EVENT), heartbeat ${interval}ms`,
        )
        return
      }

      if (msg.op === 9) {
        if (settled) return
        settled = true
        cleanup(true)
        reject(new Error('Identify/session rejected by gateway (op 9)'))
        return
      }

      if (msg.op !== 0) return

      console.error(`event: ${msg.t}`)
      if (msg.t === 'READY') {
        console.error('READY — waiting for your private message...')
        return
      }

      if (msg.t === 'GROUP_AT_MESSAGE_CREATE') {
        console.error(
          'Received group @ message; for user_openid please DM the bot instead.',
        )
        return
      }

      if (msg.t !== 'C2C_MESSAGE_CREATE') return
      if (settled) return

      const openid = msg.d?.author?.user_openid?.trim()
      const msgId = msg.d?.id?.trim() ?? ''
      const content = msg.d?.content ?? ''
      if (!openid) {
        settled = true
        cleanup(true)
        reject(new Error('C2C_MESSAGE_CREATE missing author.user_openid'))
        return
      }
      if (!msgId) {
        settled = true
        cleanup(true)
        reject(new Error('C2C_MESSAGE_CREATE missing message id'))
        return
      }
      console.error(`content: ${content}`)
      settled = true
      clearTimeout(timeout)
      // 保持 WS 在线以便被动回复；由调用方 close
      resolveListen({
        openid,
        msgId,
        close: () => cleanup(true),
      })
    })
  })
}

async function main(): Promise<void> {
  loadDotenv({ path: ENV_FILE, quiet: true })

  const appId =
    process.env.QQBOT_APP_ID?.trim() || readDotenvKey(ENV_FILE, 'QQBOT_APP_ID')
  const clientSecret =
    process.env.QQBOT_APP_SECRET?.trim() ||
    readDotenvKey(ENV_FILE, 'QQBOT_APP_SECRET')

  if (!appId || !clientSecret) {
    console.error(
      'Missing QQBOT_APP_ID or QQBOT_APP_SECRET in .env.test (see .env.test.example).',
    )
    process.exit(1)
  }

  console.error(`AppID: ${appId}`)
  const timeoutMs = parseTimeoutMs()
  const accessToken = await getAccessToken(appId, clientSecret)
  const gatewayUrl = await getGatewayUrl(accessToken)
  const listened = await listenForUserOpenid(
    gatewayUrl,
    accessToken,
    timeoutMs,
  )

  try {
    const text = `Successfully got user_openid value: ${listened.openid}`
    console.error('Sending probe reply...')
    await sendC2cText({
      accessToken,
      userOpenid: listened.openid,
      text,
      msgId: listened.msgId,
    })
  } finally {
    listened.close()
  }

  // stdout 仅 openid，便于管道；诊断一律 stderr
  console.log(listened.openid)
  console.error('Done. Paste user_openid into QQBOT_USER_OPENID if you want.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
