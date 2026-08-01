/**
 * 请求体未知 JSON 键拒绝（与 Go jsonutil.RejectUnknownObjectKeys 对齐）。
 * 错误文案英文：Unknown JSON key: <name>
 */
export const UNKNOWN_JSON_KEY_PREFIX = 'Unknown JSON key: '
export const BODY_MUST_BE_OBJECT = 'Request body must be a JSON object'

/** 非对象 / 数组 / null → BODY_MUST_BE_OBJECT；未知键 → Unknown JSON key: …（按键名排序取第一个） */
export function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
): { error: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: BODY_MUST_BE_OBJECT }
  }
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value as object).sort()) {
    if (!allowedSet.has(key)) {
      return { error: `${UNKNOWN_JSON_KEY_PREFIX}${key}` }
    }
  }
  return null
}
