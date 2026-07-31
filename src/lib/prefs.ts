const KEYS = {
  token: 'digitaltwin_token',
  adminToken: 'digitaltwin_admin_token',
  dashboardSummary: 'digitaltwin_dashboard_summary',
  timezone: 'digitaltwin_timezone',
  apiAccelerateBase: 'digitaltwin_api_accelerate_base',
} as const

function read(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(key)
}

function write(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, value)
}

export function getToken(): string {
  return read(KEYS.token) ?? ''
}

export function setToken(value: string): void {
  write(KEYS.token, value)
}

export function getAdminToken(): string {
  return read(KEYS.adminToken) ?? ''
}

export function setAdminToken(value: string): void {
  write(KEYS.adminToken, value)
}

/** Dashboard summary 组件是否展示；缺省为 true */
export function getDashboardSummary(): boolean {
  const raw = read(KEYS.dashboardSummary)
  if (raw === null) return true
  return raw === 'true'
}

export function setDashboardSummary(enabled: boolean): void {
  write(KEYS.dashboardSummary, enabled ? 'true' : 'false')
}

/** 空字符串 = 跟随浏览器 */
export function getTimezone(): string {
  return read(KEYS.timezone) ?? ''
}

export function setTimezone(value: string): void {
  write(KEYS.timezone, value)
}

/** 解析有效 IANA：prefs.timezone || 浏览器时区 */
export function resolveTimezone(): string {
  const configured = getTimezone()
  if (configured) return configured
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * API 加速地址（origin）。空 = 同源走 Vercel `/api/...`；
 * 非空 = 用该 origin 拼接（由 api-client 去尾 `/`）。
 * 仅本机 prefs，禁止用 NEXT_PUBLIC_* 下发。
 */
export function getApiAccelerateBase(): string {
  return read(KEYS.apiAccelerateBase) ?? ''
}

export function setApiAccelerateBase(value: string): void {
  write(KEYS.apiAccelerateBase, value.trim())
}
