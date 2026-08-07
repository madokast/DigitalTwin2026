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

describe('api-client url helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', createMemoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('normalizeApiBase strips trailing slashes', async () => {
    const { normalizeApiBase } = await import('./api-client')
    expect(normalizeApiBase('')).toBe('')
    expect(normalizeApiBase('  https://example.fcapp.run/  ')).toBe(
      'https://example.fcapp.run',
    )
    expect(normalizeApiBase('https://example.fcapp.run///')).toBe(
      'https://example.fcapp.run',
    )
  })

  it('apiUrl uses relative path when accelerate base is empty', async () => {
    const { apiUrl } = await import('./api-client')
    expect(apiUrl('/api/query')).toBe('/api/query')
    expect(apiUrl('/api/query?tz=UTC')).toBe('/api/query?tz=UTC')
  })

  it('apiUrl prefixes normalized accelerate base when set', async () => {
    const prefs = await import('./prefs')
    prefs.setApiAccelerateBase('https://example.fcapp.run/')
    const { apiUrl } = await import('./api-client')
    expect(apiUrl('/api/query')).toBe('https://example.fcapp.run/api/query')
    expect(apiUrl('/api/admin/tags/normalize')).toBe(
      'https://example.fcapp.run/api/admin/tags/normalize',
    )
  })
})
