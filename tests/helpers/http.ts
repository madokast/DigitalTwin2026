import { NextRequest } from 'next/server'

export function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  headers.set('Authorization', `Bearer ${process.env.DIGITAL_TWIN_TOKEN}`)
  return headers
}

export function jsonPost(url: string, body: unknown, withAuth = true): NextRequest {
  const headers = withAuth ? authHeaders({ 'Content-Type': 'application/json' }) : new Headers({
    'Content-Type': 'application/json',
  })
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

export function jsonPatch(url: string, body: unknown, withAuth = true): NextRequest {
  const headers = withAuth ? authHeaders({ 'Content-Type': 'application/json' }) : new Headers({
    'Content-Type': 'application/json',
  })
  return new NextRequest(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

export function jsonGet(url: string, withAuth = true): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: withAuth ? authHeaders() : new Headers(),
  })
}

/** multipart POST；默认字段名 file，Content-Type 由 FormData 自动带 boundary。 */
export function multipartPost(
  url: string,
  fileContent: string | Blob,
  opts?: {
    filename?: string
    type?: string
    withAuth?: boolean
    fieldName?: string
  },
): NextRequest {
  const form = new FormData()
  const type = opts?.type ?? 'application/x-ndjson'
  const blob =
    typeof fileContent === 'string'
      ? new Blob([fileContent], { type })
      : fileContent
  form.append(opts?.fieldName ?? 'file', blob, opts?.filename ?? 'records.jsonl')
  const headers =
    opts?.withAuth === false
      ? new Headers()
      : authHeaders()
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: form,
  })
}
