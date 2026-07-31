/** Telegram Bot 通知：录入成功 best-effort 推送；probe 严格校验配置与发送结果 */

export type EnvLike = {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_USER_ID?: string
}

export type TelegramConfig = {
  configured: boolean
  token: string
  userId: string
  missing: string[]
}

/** 与 Drizzle returning / Go record JSON 对齐的录入行 */
export type NotifyRecord = {
  id: string
  happenedAt: Date | string
  valueNumber?: string | null
  valueText?: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation?: string | null
}

export type SendResult = { ok: true } | { ok: false; error: string }

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export function getTelegramConfig(env: EnvLike = process.env): TelegramConfig {
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

export function isTelegramConfigured(env: EnvLike = process.env): boolean {
  return getTelegramConfig(env).configured
}

/** 未配置时的英文错误；已配置返回 null */
export function telegramConfigError(env: EnvLike = process.env): string | null {
  const cfg = getTelegramConfig(env)
  if (cfg.configured) return null
  if (cfg.missing.length === 2) {
    return 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_USER_ID)'
  }
  return `Telegram is not configured (missing ${cfg.missing.join(', ')})`
}

function formatHappenedAt(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value
}

function formatTags(tagsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(tagsJson)
    if (Array.isArray(parsed)) {
      return parsed.map(String).join(', ')
    }
  } catch {
    // 非 JSON 时原样展示
  }
  return tagsJson
}

/** 英文纯文本排版，非 JSON 倾倒 */
export function formatRecordMessage(record: NotifyRecord): string {
  const lines = [
    'New record',
    `id: ${record.id}`,
    `happened_at: ${formatHappenedAt(record.happenedAt)}`,
  ]

  if (record.valueNumber != null && record.valueNumber !== '') {
    lines.push(`value_number: ${record.valueNumber}`)
  } else {
    lines.push(`value_text: ${record.valueText ?? ''}`)
  }

  lines.push(`tags: ${formatTags(record.tags)}`)
  lines.push(`objective: ${record.objectiveContext}`)

  const subj = record.subjectiveInterpretation
  lines.push(
    `subjective: ${subj != null && subj !== '' ? subj : '(null)'}`,
  )

  return lines.join('\n')
}

export async function sendTelegramMessage(
  text: string,
  options?: { env?: EnvLike; fetch?: FetchLike },
): Promise<SendResult> {
  const env = options?.env ?? process.env
  const cfg = getTelegramConfig(env)
  if (!cfg.configured) {
    return { ok: false, error: telegramConfigError(env)! }
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Telegram sendMessage failed: ${msg}` }
  }
}

/** 录入成功后 best-effort：未配置跳过；失败只打日志 */
export async function notifyRecordInserted(
  record: NotifyRecord,
  options?: { env?: EnvLike; fetch?: FetchLike },
): Promise<void> {
  const env = options?.env ?? process.env
  if (!isTelegramConfigured(env)) {
    console.warn('Telegram notify skipped: not configured')
    return
  }

  const result = await sendTelegramMessage(formatRecordMessage(record), options)
  if (!result.ok) {
    console.error('Telegram notify failed:', result.error)
  }
}
