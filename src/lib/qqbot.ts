/** QQ Bot 主动 C2C 通知：token 进程内缓存；probe / notify 共用 sendQqMessage */

/** 与 Telegram / Go HTTP 客户端 15s 对齐 */
export const QQBOT_HTTP_TIMEOUT_MS = 15_000

/** fetch/超时等传输失败：固定英文，避免 AbortError 文案分叉；不含密钥 */
export const QQBOT_TRANSPORT_FAILED =
  'QQ Bot sendMessage failed: request failed' as const

const API_BASES = [
  'https://api.sgroup.qq.com',
  'https://api.bot.qq.com',
] as const

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

/** 提前刷新窗口：距过期不足此秒数则重新拉 token */
const TOKEN_REFRESH_SKEW_MS = 60_000

export type EnvLike = {
  QQBOT_APP_ID?: string
  QQBOT_APP_SECRET?: string
  QQBOT_USER_OPENID?: string
}

/** process.env 键比 EnvLike 宽；作默认参数时收窄 */
const processEnvLike = (): EnvLike => process.env as EnvLike

export type QqbotConfig = {
  configured: boolean
  appId: string
  appSecret: string
  userOpenid: string
  missing: string[]
}

export type SendResult = { ok: true } | { ok: false; error: string }

type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text?: () => Promise<string>
  json: () => Promise<unknown>
}>

type TokenCache = {
  token: string
  /** 绝对过期时间（ms）；读取时提前 TOKEN_REFRESH_SKEW_MS 视为失效 */
  expiresAtMs: number
}

let tokenCache: TokenCache | null = null

/** 单测用：清空进程内 access_token 缓存 */
export function clearAccessTokenCacheForTests(): void {
  tokenCache = null
}

/** 与 Go `qqbot.LoadConfig` 对齐 */
export function loadConfig(env: EnvLike = processEnvLike()): QqbotConfig {
  const appId = (env.QQBOT_APP_ID ?? '').trim()
  const appSecret = (env.QQBOT_APP_SECRET ?? '').trim()
  const userOpenid = (env.QQBOT_USER_OPENID ?? '').trim()
  const missing: string[] = []
  if (!appId) missing.push('QQBOT_APP_ID')
  if (!appSecret) missing.push('QQBOT_APP_SECRET')
  if (!userOpenid) missing.push('QQBOT_USER_OPENID')
  return {
    configured: missing.length === 0,
    appId,
    appSecret,
    userOpenid,
    missing,
  }
}

export function isConfigured(env: EnvLike = processEnvLike()): boolean {
  return loadConfig(env).configured
}

/** 与 Go `qqbot.ConfigError` 对齐：未配置时的英文错误；已配置返回 null */
export function configError(env: EnvLike = processEnvLike()): string | null {
  const cfg = loadConfig(env)
  if (cfg.configured) return null
  if (cfg.missing.length === 3) {
    return 'QQ Bot is not configured (QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID)'
  }
  return `QQ Bot is not configured (missing ${cfg.missing.join(', ')})`
}

function cachedTokenValid(): string | null {
  if (!tokenCache) return null
  if (Date.now() >= tokenCache.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
    return null
  }
  return tokenCache.token
}

async function fetchAccessToken(
  appId: string,
  clientSecret: string,
  fetchFn: FetchLike,
): Promise<SendResult & { token?: string }> {
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
      signal: AbortSignal.timeout(QQBOT_HTTP_TIMEOUT_MS),
    })

    let accessToken: string | undefined
    let expiresIn: number | undefined
    let message: string | undefined
    try {
      const data = (await res.json()) as {
        access_token?: string
        expires_in?: number | string
        message?: string
        msg?: string
      }
      accessToken = data.access_token
      const rawExp = data.expires_in
      if (typeof rawExp === 'number' && Number.isFinite(rawExp)) {
        expiresIn = rawExp
      } else if (typeof rawExp === 'string' && rawExp.trim() !== '') {
        const n = Number(rawExp)
        if (Number.isFinite(n)) expiresIn = n
      }
      message = data.message || data.msg
    } catch {
      // 非 JSON
    }

    if (!accessToken) {
      const reason = message || `HTTP ${res.status}`
      return { ok: false, error: `QQ Bot getAppAccessToken failed: ${reason}` }
    }

    const ttlSec = expiresIn != null && expiresIn > 0 ? expiresIn : 7200
    tokenCache = {
      token: accessToken,
      expiresAtMs: Date.now() + ttlSec * 1000,
    }
    return { ok: true, token: accessToken }
  } catch {
    return { ok: false, error: QQBOT_TRANSPORT_FAILED }
  }
}

async function resolveAccessToken(
  cfg: QqbotConfig,
  fetchFn: FetchLike,
): Promise<SendResult & { token?: string }> {
  const cached = cachedTokenValid()
  if (cached) return { ok: true, token: cached }
  return fetchAccessToken(cfg.appId, cfg.appSecret, fetchFn)
}

async function readErrorReason(
  res: { status: number; text?: () => Promise<string>; json: () => Promise<unknown> },
): Promise<string> {
  let raw = ''
  try {
    if (typeof res.text === 'function') {
      raw = await res.text()
    } else {
      raw = JSON.stringify(await res.json())
    }
  } catch {
    return `HTTP ${res.status}`
  }
  try {
    const body = JSON.parse(raw) as {
      message?: string
      msg?: string
      code?: number
    }
    return (
      body.message ||
      body.msg ||
      (body.code != null ? `code ${body.code}` : `HTTP ${res.status}`)
    )
  } catch {
    return `HTTP ${res.status}`
  }
}

/**
 * 主动 C2C 文本（无 msg_id）。双 API base 依次尝试。
 * 错误英文不含 appSecret / access_token。
 */
export async function sendQqMessage(
  text: string,
  options?: { env?: EnvLike; fetch?: FetchLike },
): Promise<SendResult> {
  const env = options?.env ?? processEnvLike()
  const cfg = loadConfig(env)
  if (!cfg.configured) {
    return { ok: false, error: configError(env)! }
  }

  const fetchFn = options?.fetch ?? (globalThis.fetch as FetchLike)
  const tokenResult = await resolveAccessToken(cfg, fetchFn)
  if (!tokenResult.ok) {
    return { ok: false, error: tokenResult.error }
  }
  if (!tokenResult.token) {
    return { ok: false, error: QQBOT_TRANSPORT_FAILED }
  }

  const path = `/v2/users/${encodeURIComponent(cfg.userOpenid)}/messages`
  const payload = {
    content: text,
    msg_type: 0,
  }
  const headers = {
    Authorization: `QQBot ${tokenResult.token}`,
    'Content-Type': 'application/json; charset=utf-8',
  }

  let lastErr = 'send failed'
  for (const base of API_BASES) {
    try {
      const res = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(QQBOT_HTTP_TIMEOUT_MS),
      })
      if (res.ok) {
        return { ok: true }
      }
      lastErr = await readErrorReason(res)
    } catch {
      lastErr = 'request failed'
    }
  }

  return { ok: false, error: `QQ Bot sendMessage failed: ${lastErr}` }
}
