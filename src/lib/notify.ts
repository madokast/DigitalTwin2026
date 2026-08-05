/**
 * 统一用户通知入口：已配置的 Telegram / QQ 并行发送 + timed await。
 * 录入路径只调本模块；probe 仍走各渠道 send*，不经 notify_user。
 */

import { after } from 'next/server'
import {
  formatNumberBatchMessage,
  formatRecordMessage,
  formatTransactionBatchMessage,
  isTelegramConfigured,
  sendTelegramMessage,
  type EnvLike as TelegramEnvLike,
  type FetchLike as TelegramFetchLike,
  type NotifyRecord,
} from '@/lib/telegram'
import {
  isConfigured as isQqbotConfigured,
  sendQqMessage,
  type EnvLike as QqbotEnvLike,
} from '@/lib/qqbot'

/** 双渠道并行等待上限（与单渠道 HTTP 超时同量级） */
export const NOTIFY_PARALLEL_TIMEOUT_MS = 15_000

/**
 * 单条通知文本长度上限（字符）。Telegram sendMessage 上限 4096（UTF-16
 * code units），QQ 同类；统一留余量截断，防止长文（如复盘全文）被渠道拒收。
 * 与 Go notify.NotifyMessageMaxLen 同值。
 */
export const NOTIFY_MESSAGE_MAX_LEN = 4000

/** 截断尾部标记（英文，用户可见） */
export const NOTIFY_TRUNCATION_SUFFIX = '\n… (truncated)'

/**
 * 通知文本统一截断：≤上限原样；超出 → 保留前 (maxLen − suffix) 字符 + 后缀，
 * 总长恰为 maxLen。UTF-16 code unit 计长（与 Telegram 同计法）。
 * 与 Go notify.TruncateNotifyMessage 同构；边界样例见 testdata/notify-truncate-cases.json。
 */
export function truncateNotifyMessage(text: string): string {
  if (text.length <= NOTIFY_MESSAGE_MAX_LEN) return text
  const keep = NOTIFY_MESSAGE_MAX_LEN - NOTIFY_TRUNCATION_SUFFIX.length
  return text.slice(0, keep) + NOTIFY_TRUNCATION_SUFFIX
}

export type EnvLike = TelegramEnvLike &
  QqbotEnvLike & {
    SUPPRESS_BOT_NOTIFICATION?: string
  }

type FetchLike = TelegramFetchLike

/** process.env 键比 EnvLike 宽；作默认参数时收窄 */
const processEnvLike = (): EnvLike => process.env as EnvLike

function envFlagOn(value: string | undefined): boolean {
  return (value ?? '').trim() === '1'
}

/** 注入值非空优先；空则回退 process.env（与 Go ShouldSuppressBotNotification 一致） */
function envOrProcess(
  env: EnvLike,
  key: 'SUPPRESS_BOT_NOTIFICATION',
): string {
  const injected = (env[key] ?? '').trim()
  if (injected !== '') return injected
  return (process.env[key] ?? '').trim()
}

/**
 * SUPPRESS_BOT_NOTIFICATION trim 后严格等于 '1' 时跳过业务自动 notify。
 * probe 走各渠道 send*，不受此限制。
 * 同时看注入 env 与 process.env（Vitest setup / TestMain 设的 SUPPRESS_BOT_NOTIFICATION）。
 */
export function shouldSuppressBotNotification(
  env: EnvLike = processEnvLike(),
): boolean {
  return envFlagOn(envOrProcess(env, 'SUPPRESS_BOT_NOTIFICATION'))
}

/**
 * 在 HTTP 成功响应写出之后再跑通知，避免渠道慢/挂拖垮 201。
 * 有 Next request scope 时用 `after()`；单元测等无 scope 时退化为立即 fire-and-forget。
 *
 * 刻意允许的双端差异（docs/20260801-api-layering.md §1.1 / §7）：
 * Next 用 `after()`，Go httpx 用 `go` 协程；语义同为「成功后不阻塞写响应的 best-effort notify」。
 */
export function scheduleBestEffortNotify(task: () => Promise<void>): void {
  const run = () => {
    void task().catch(() => {
      // notify* 已吞错；防未处理 rejection
    })
  }
  try {
    after(run)
  } catch {
    run()
  }
}

/**
 * 统一发送：已配置渠道并行；总等待约 timeoutMs（默认 15s）后 allSettled/超时即返回。
 * 失败只打英文日志，不含密钥。
 *
 * 刻意允许的双端差异（docs/20260801-api-layering.md §1.1）：
 * 导出名 `notify_user`（snake_case，历史/契约调用）；Go 为 `NotifyUser`。同一 stem，语义对齐。
 */
export async function notify_user(
  text: string,
  options?: { env?: EnvLike; fetch?: FetchLike; timeoutMs?: number },
): Promise<void> {
  const env = options?.env ?? processEnvLike()
  if (shouldSuppressBotNotification(env)) {
    return
  }

  // 统一截断：保护各渠道长度限制（Telegram 4096 等），先截断再分发
  const message = truncateNotifyMessage(text)

  const fetchFn = options?.fetch
  const timeoutMs = options?.timeoutMs ?? NOTIFY_PARALLEL_TIMEOUT_MS
  const tasks: Promise<void>[] = []

  if (isTelegramConfigured(env)) {
    tasks.push(
      (async () => {
        const result = await sendTelegramMessage(message, {
          env,
          fetch: fetchFn,
        })
        if (!result.ok) {
          console.error('Telegram notify failed:', result.error)
        }
      })(),
    )
  }

  if (isQqbotConfigured(env)) {
    tasks.push(
      (async () => {
        const result = await sendQqMessage(message, {
          env,
          fetch: fetchFn,
        })
        if (!result.ok) {
          console.error('QQ Bot notify failed:', result.error)
        }
      })(),
    )
  }

  if (tasks.length === 0) {
    console.warn('Notify skipped: no channels configured')
    return
  }

  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs)
    }),
  ])
}

/** 录入成功后 best-effort：suppress / 未配置跳过；失败只打日志 */
export async function notifyRecordInserted(
  record: NotifyRecord,
  options?: { env?: EnvLike; fetch?: FetchLike; timeoutMs?: number },
): Promise<void> {
  await notify_user(formatRecordMessage(record), options)
}

/** transaction batch 成功后 best-effort 一条摘要 */
export async function notifyTransactionBatchInserted(
  rows: NotifyRecord[],
  options?: { env?: EnvLike; fetch?: FetchLike; timeoutMs?: number },
): Promise<void> {
  if (rows.length === 0) return
  await notify_user(formatTransactionBatchMessage(rows), options)
}

/** number batch 成功后 best-effort 一条摘要 */
export async function notifyNumberBatchInserted(
  rows: NotifyRecord[],
  options?: { env?: EnvLike; fetch?: FetchLike; timeoutMs?: number },
): Promise<void> {
  if (rows.length === 0) return
  await notify_user(formatNumberBatchMessage(rows), options)
}

export type { NotifyRecord }
