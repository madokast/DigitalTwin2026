import {
  getAdminToken,
  getToken,
} from '@/lib/prefs'

export type TwinRecord = {
  id: string
  happenedAt: string
  valueNumber: string | null
  valueText: string | null
  tags: string
  objectiveContext: string
  subjectiveInterpretation: string | null
}

function authHeader(): HeadersInit {
  const token = getToken() || getAdminToken()
  if (!token) {
    throw new Error('请先在设置中填写 Token 或 Admin Token')
  }
  return { Authorization: `Bearer ${token}` }
}

function adminAuthHeader(): HeadersInit {
  const token = getAdminToken()
  if (!token) {
    throw new Error('需要 Admin Token（勿把 Admin Token 交给 AI）')
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json()
  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `请求失败（${res.status}）`,
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
  const res = await fetch(`/api/query/summary?${params}`, {
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
  const res = await fetch(`/api/query${qs}`, {
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
  const res = await fetch('/api/query/tags', {
    headers: authHeader(),
  })
  const data = await parseJson<{ success: boolean; tags: Record<string, number> }>(res)
  return data.tags ?? {}
}

export async function renameTag(from: string, to: string): Promise<number> {
  const res = await fetch('/api/admin/tags/rename', {
    method: 'POST',
    headers: adminAuthHeader(),
    body: JSON.stringify({ from, to }),
  })
  const data = await parseJson<{ success: boolean; updated: number }>(res)
  return data.updated
}
