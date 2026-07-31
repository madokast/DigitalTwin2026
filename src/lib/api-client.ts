import { getAdminToken, getApiAccelerateBase } from '@/lib/prefs'

export type TwinRecord = {
  id: string
  happenedAt: string
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

/** 规范化加速 base：去尾 `/`；空则返回 ""（同源相对路径）。 */
export function normalizeApiBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 拼 API URL：prefs 加速地址为空 → `/api/...`；
 * 非空 → `${base}/api/...`（base 已去尾 `/`）。
 */
export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const base = normalizeApiBase(getApiAccelerateBase())
  if (!base) return normalizedPath
  return `${base}${normalizedPath}`
}

function authHeader(json = false): HeadersInit {
  const token = getAdminToken()
  if (!token) {
    throw new Error('Please set Admin Token in Settings')
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json()
  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`,
    )
  }
  return data as T
}

export async function fetchSummary(tz: string): Promise<{
  success: boolean
  total: number
  today: number
  tz: string
}> {
  const params = new URLSearchParams({ tz })
  const res = await fetch(apiUrl(`/api/query/summary?${params}`), {
    headers: authHeader(),
  })
  return parseJson(res)
}

export async function fetchRecords(search: string): Promise<{
  success: boolean
  count: number
  page: number
  pageSize: number
  records: TwinRecord[]
}> {
  const qs = search.startsWith('?') ? search : search ? `?${search}` : ''
  const res = await fetch(apiUrl(`/api/query${qs}`), {
    headers: authHeader(),
  })
  return parseJson(res)
}

export async function fetchRecordById(id: string): Promise<TwinRecord | null> {
  const params = new URLSearchParams({ id })
  const data = await fetchRecords(params.toString())
  return data.records[0] ?? null
}

export async function fetchTags(): Promise<Record<string, number>> {
  const res = await fetch(apiUrl('/api/query/tags'), {
    headers: authHeader(),
  })
  const data = await parseJson<{ success: boolean; tags: Record<string, number> }>(res)
  return data.tags ?? {}
}

export async function renameTag(from: string, to: string): Promise<number> {
  const res = await fetch(apiUrl('/api/admin/tags/rename'), {
    method: 'POST',
    headers: authHeader(true),
    body: JSON.stringify({ from, to }),
  })
  const data = await parseJson<{ success: boolean; updated: number }>(res)
  return data.updated
}

export type PatchRecordBody = {
  happened_at: string
  value_number: number | string | null
  value_text: string | null
  tags: string[]
  objective_context: string
  subjective_interpretation: string | null
}

export async function patchRecord(
  id: string,
  body: PatchRecordBody,
): Promise<TwinRecord> {
  const res = await fetch(apiUrl(`/api/admin/records/${id}`), {
    method: 'PATCH',
    headers: authHeader(true),
    body: JSON.stringify(body),
  })
  const data = await parseJson<{ success: boolean; record: TwinRecord }>(res)
  return data.record
}
