/**
 * 录入 API 请求体可选 `suppress_notification`：为 true 时跳过 notify_user。
 * 字段不进 DB；须在 Create 之前校验类型。
 */

export type SuppressNotificationResult =
  | { ok: true; value: boolean }
  | { ok: false; error: string }

export const INVALID_SUPPRESS_NOTIFICATION =
  'Invalid suppress_notification' as const

/**
 * 从已解析 JSON body peek `suppress_notification`。
 * 省略 / null / undefined → false；非 boolean → 400 文案。
 */
export function readSuppressNotification(
  body: unknown,
): SuppressNotificationResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: true, value: false }
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'suppress_notification')) {
    return { ok: true, value: false }
  }
  const value = (body as Record<string, unknown>).suppress_notification
  if (value === null || value === undefined) {
    return { ok: true, value: false }
  }
  if (typeof value !== 'boolean') {
    return { ok: false, error: INVALID_SUPPRESS_NOTIFICATION }
  }
  return { ok: true, value }
}
