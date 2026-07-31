import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null
    },
    removeItem(key: string) {
      map.delete(key)
    },
    setItem(key: string, value: string) {
      map.set(key, String(value))
    },
  }
}

describe('prefs', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', createMemoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults: empty admin token, summary on, empty timezone, empty api accelerate base', async () => {
    const prefs = await import('./prefs')
    expect(prefs.getAdminToken()).toBe('')
    expect(prefs.getDashboardSummary()).toBe(true)
    expect(prefs.getTimezone()).toBe('')
    expect(prefs.getApiAccelerateBase()).toBe('')
  })

  it('persists adminToken via get/set', async () => {
    const prefs = await import('./prefs')
    prefs.setAdminToken('admin-token')
    expect(prefs.getAdminToken()).toBe('admin-token')
  })

  it('persists dashboard.summary boolean', async () => {
    const prefs = await import('./prefs')
    prefs.setDashboardSummary(false)
    expect(prefs.getDashboardSummary()).toBe(false)
    prefs.setDashboardSummary(true)
    expect(prefs.getDashboardSummary()).toBe(true)
  })

  it('resolveTimezone falls back to browser IANA when timezone is empty', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'America/New_York',
    } as Intl.ResolvedDateTimeFormatOptions)

    const prefs = await import('./prefs')
    expect(prefs.getTimezone()).toBe('')
    expect(prefs.resolveTimezone()).toBe('America/New_York')
  })

  it('resolveTimezone uses configured IANA when timezone is set', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'America/New_York',
    } as Intl.ResolvedDateTimeFormatOptions)

    const prefs = await import('./prefs')
    prefs.setTimezone('Asia/Shanghai')
    expect(prefs.getTimezone()).toBe('Asia/Shanghai')
    expect(prefs.resolveTimezone()).toBe('Asia/Shanghai')
  })

  it('persists apiAccelerateBase and trims on write', async () => {
    const prefs = await import('./prefs')
    prefs.setApiAccelerateBase('  https://example.fcapp.run/  ')
    expect(prefs.getApiAccelerateBase()).toBe('https://example.fcapp.run/')
    prefs.setApiAccelerateBase('')
    expect(prefs.getApiAccelerateBase()).toBe('')
  })
})
