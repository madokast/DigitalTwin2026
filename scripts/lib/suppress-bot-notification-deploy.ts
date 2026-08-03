/**
 * deploy / collect 强制注入 SUPPRESS_BOT_NOTIFICATION（用户透明、不问、不手填）。
 * 语义见 docs/20260803-suppress-bot-notification.md §2.5 / §10 阶段 2。
 */

export const SUPPRESS_BOT_NOTIFICATION = 'SUPPRESS_BOT_NOTIFICATION' as const

/** test → 1（业务静音）；prod → 0（正常发） */
export function forcedSuppressBotNotificationValue(
  mode: 'test' | 'prod',
): '0' | '1' {
  return mode === 'test' ? '1' : '0'
}

/** 覆盖写入强制值（漏写或误带的值一律被盖掉） */
export function withForcedSuppressBotNotification(
  values: Record<string, string>,
  mode: 'test' | 'prod',
): Record<string, string> {
  return {
    ...values,
    [SUPPRESS_BOT_NOTIFICATION]: forcedSuppressBotNotificationValue(mode),
  }
}
