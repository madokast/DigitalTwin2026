/**
 * HTTP 层 JSON 绑定：与 Go `faas/internal/httpx` / decode 失败文案对齐。
 * 空 body、语法错误、非 object 等客户端问题 → 400，不得落入通用 500 catch。
 * 超过 MaxBodyBytes → 413（与 Go readBody 对齐）。
 */

export const INVALID_JSON_BODY = 'Invalid JSON body' as const
/** 与 Go httpx.MaxBodyBytes（256 KiB）对齐 */
export const MAX_HTTP_BODY_BYTES = 256 * 1024
export const REQUEST_BODY_TOO_LARGE = 'Request body too large' as const

export type ReadJsonOk = { ok: true; value: Record<string, unknown> }
export type ReadJsonErr =
  | {
      ok: false
      error: typeof INVALID_JSON_BODY
      status: 400
    }
  | {
      ok: false
      error: typeof REQUEST_BODY_TOO_LARGE
      status: 413
    }
export type ReadJsonResult = ReadJsonOk | ReadJsonErr

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readJsonBody(request: Request): Promise<ReadJsonResult> {
  let buf: ArrayBuffer
  try {
    buf = await request.arrayBuffer()
  } catch {
    return { ok: false, error: INVALID_JSON_BODY, status: 400 }
  }
  if (buf.byteLength > MAX_HTTP_BODY_BYTES) {
    return { ok: false, error: REQUEST_BODY_TOO_LARGE, status: 413 }
  }

  try {
    const text = new TextDecoder('utf-8').decode(buf)
    const value: unknown = text.length === 0 ? undefined : JSON.parse(text)
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
