/**
 * HTTP 层 JSON 绑定：与 Go `fc/internal/httpx` / decode 失败文案对齐。
 * 空 body、语法错误、非 object 等客户端问题 → 400，不得落入通用 500 catch。
 */

export const INVALID_JSON_BODY = 'Invalid JSON body' as const

export type ReadJsonOk = { ok: true; value: Record<string, unknown> }
export type ReadJsonErr = {
  ok: false
  error: typeof INVALID_JSON_BODY
  status: 400
}
export type ReadJsonResult = ReadJsonOk | ReadJsonErr

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readJsonBody(request: Request): Promise<ReadJsonResult> {
  try {
    const value = await request.json()
    // Go 对 `null` unmarshal 进 struct/map 为零值且不报错；对齐为 {}
    if (value === null) {
      return { ok: true, value: {} }
    }
    if (!isPlainObject(value)) {
      return { ok: false, error: INVALID_JSON_BODY, status: 400 }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, error: INVALID_JSON_BODY, status: 400 }
  }
}
