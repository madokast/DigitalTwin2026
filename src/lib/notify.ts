/**
 * 统一用户通知入口：已配置的 Telegram / QQ 并行发送 + timed await。
 * 录入路径只调本模块；probe 仍走各渠道 send*，不经 notify_user。
 */

import { after } from 'next/server'
import {
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

export type EnvLike = TelegramEnvLike &
  QqbotEnvLike & {
    DIGITAL_TWIN_TEST?: string
    NOTIFY_ALLOW_IN_TEST?: string
  }

type FetchLike = TelegramFetchLike

/** process.env 键比 EnvLike 宽；作默认参数时收窄 */
const processEnvLike = (): EnvLike => process.env as EnvLike

function envFlagOn(value: string | undefined): boolean {
  return (value ?? '').trim() === '1'
}

/** 注入值非空优先；空则回退 process.env（与 Go ShouldSkipNotifyInTest 一致） */
function envOrProcess(
  env: EnvLike,
  key: 'DIGITAL_TWIN_TEST' | 'NOTIFY_ALLOW_IN_TEST',
): string {
  const injected = (env[key] ?? '').trim()
  if (injected !== '') return injected
  return (process.env[key] ?? '').trim()
}

/**
 * 测试态下跳过录入后自动通知。
 * NOTIFY_ALLOW_IN_TEST=1 可放行（单测注入 mock 时用）。
 * probe 走各渠道 send*，不受此限制。
 * 同时看注入 env 与 process.env（Vitest setup / TestMain 设的 DIGITAL_TWIN_TEST）。
 */
export function shouldSkipNotifyInTest(env: EnvLike = processEnvLike()): boolean {
  if (envFlagOn(envOrProcess(env, 'NOTIFY_ALLOW_IN_TEST'))) {
    return false
  }
  return envFlagOn(envOrProcess(env, 'DIGITAL_TWIN_TEST'))
}

/**
 * 在 HTTP 成功响应写出之后再跑通知，避免渠道慢/挂拖垮 201。
 * 有 Next request scope 时用 `after()`；单元测等无 scope 时退化为立即 fire-and-forget。
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
 */
export async function notify_user(
  text: string,
  options?: { env?: EnvLike; fetch?: FetchLike; timeoutMs?: number },
): Promise<void> {
  const env = options?.env ?? processEnvLike()
  if (shouldSkipNotifyInTest(env)) {
    return
  }

  const fetchFn = options?.fetch
  const timeoutMs = options?.timeoutMs ?? NOTIFY_PARALLEL_TIMEOUT_MS
  const tasks: Promise<void>[] = []

  if (isTelegramConfigured(env)) {
    tasks.push(
      (async () => {
        const result = await sendTelegramMessage(text, {
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
        const result = await sendQqMessage(text, {
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

/** 录入成功后 best-effort：测试态 / 未配置跳过；失败只打日志 */
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

export type { NotifyRecord }
