/** Telegram Bot 通知渠道：配置 / 格式化 / sendMessage；统一入口见 notify.ts */

import { RESERVED_TAG_TRANSACTION_ENTRY } from '@/lib/tags'

/** 与 Go `http.Client{Timeout: 15 * time.Second}` 对齐 */
export const TELEGRAM_HTTP_TIMEOUT_MS = 15_000

/** fetch/超时等传输失败：固定英文，避免 AbortError 与 Go deadline 文案分叉 */
export const TELEGRAM_TRANSPORT_FAILED =
  'Telegram sendMessage failed: request failed' as const

export type EnvLike = {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_USER_ID?: string
}

/** process.env 键比 EnvLike 宽；作默认参数时收窄 */
const processEnvLike = (): EnvLike => process.env as EnvLike

export type TelegramConfig = {
  configured: boolean
  token: string
  userId: string
  missing: string[]
}

/**
 * 与 API Record / Go `record.Record` 对齐（snake_case）。
 * `happened_at` 须为已按 utc_offset 格式化的带区串（fromDB 产出）；禁止再 toISOString。
 */
export type NotifyRecord = {
  id: string
  happened_at: string
  numeric_value?: string
  raw_content: string | null
  tags: string[]
  objective_context: string
  subjective_interpretation: string | null
}

export type SendResult = { ok: true } | { ok: false; error: string }

export type FetchLike = (
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
  json: () => Promise<unknown>
}>

/** 与 Go `telegram.LoadConfig` 对齐 */
export function loadConfig(env: EnvLike = processEnvLike()): TelegramConfig {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim()
  const userId = (env.TELEGRAM_USER_ID ?? '').trim()
  const missing: string[] = []
  if (!token) missing.push('TELEGRAM_BOT_TOKEN')
  if (!userId) missing.push('TELEGRAM_USER_ID')
  return {
    configured: missing.length === 0,
    token,
    userId,
    missing,
  }
}

export function isTelegramConfigured(env: EnvLike = processEnvLike()): boolean {
  return loadConfig(env).configured
}

/** 与 Go `telegram.ConfigError` 对齐：未配置时的英文错误；已配置返回 null */
export function configError(env: EnvLike = processEnvLike()): string | null {
  const cfg = loadConfig(env)
  if (cfg.configured) return null
  if (cfg.missing.length === 2) {
    return 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)'
  }
  return `Telegram is not configured (missing ${cfg.missing.join(', ')})`
}

/** 英文纯文本排版，非 JSON 倾倒；时间串原样（须已 format） */
export function formatRecordMessage(record: NotifyRecord): string {
  const lines = [
    'New record',
    `id: ${record.id}`,
    `happened_at: ${record.happened_at}`,
  ]

  if (record.numeric_value != null && record.numeric_value !== '') {
    lines.push(`numeric_value: ${record.numeric_value}`)
  } else {
    lines.push(`raw_content: ${record.raw_content ?? ''}`)
  }

  lines.push(`tags: ${record.tags.join(', ')}`)
  lines.push(`objective: ${record.objective_context}`)

  const subj = record.subjective_interpretation
  lines.push(
    `subjective: ${subj != null && subj !== '' ? subj : '(null)'}`,
  )

  return lines.join('\n')
}

/** 整单 transaction batch 摘要（不逐条刷屏） */
export function formatTransactionBatchMessage(rows: NotifyRecord[]): string {
  const n = rows.length
  let sumLabel = '(mixed)'
  const amounts = rows
    .map((r) => r.numeric_value)
    .filter((v): v is string => v != null && v !== '')
  if (amounts.length === n) {
    // 仅展示字符串拼接提示；不强制精确十进制求和（避免浮点）
    sumLabel = amounts.join(' + ')
  }
  const firstMemo = rows[0]?.objective_context ?? ''
  const happened = rows[0]?.happened_at ?? ''
  const typeLabel = transactionTypeFromTags(rows[0]?.tags) ?? '(unknown)'
  return [
    'New transaction batch',
    `type: ${typeLabel}`,
    `inserted: ${n}`,
    `happened_at: ${happened}`,
    `amounts: ${sumLabel}`,
    `first_memo: ${firstMemo}`,
  ].join('\n')
}

/** 从 tags 数组取 transaction_entry:{type} 中的 type */
function transactionTypeFromTags(tagList: string[] | undefined): string | null {
  if (!tagList) return null
  const prefix = `${RESERVED_TAG_TRANSACTION_ENTRY}:`
  for (const item of tagList) {
    if (item.startsWith(prefix)) {
      const rest = item.slice(prefix.length)
      if (rest) return rest
    }
  }
  return null
}

export async function sendTelegramMessage(
  text: string,
  options?: { env?: EnvLike; fetch?: FetchLike },
): Promise<SendResult> {
  const env = options?.env ?? processEnvLike()
  const cfg = loadConfig(env)
  if (!cfg.configured) {
    return { ok: false, error: configError(env)! }
  }

  const fetchFn = options?.fetch ?? (globalThis.fetch as FetchLike)
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.userId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM_HTTP_TIMEOUT_MS),
    })

    let description: string | undefined
    try {
      const data = (await res.json()) as {
        ok?: boolean
        description?: string
      }
      if (data?.ok) {
        return { ok: true }
      }
      description = data?.description
    } catch {
      // 非 JSON 响应
    }

    const reason = description || `HTTP ${res.status}`
    return { ok: false, error: `Telegram sendMessage failed: ${reason}` }
  } catch {
    return { ok: false, error: TELEGRAM_TRANSPORT_FAILED }
  }
}
