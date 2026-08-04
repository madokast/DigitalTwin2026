import { describe, expect, it } from 'vitest'
import { maskValue, replaceEnvLine, sslFromUrl } from './rotate-test-secrets'

describe('maskValue', () => {
  it('masks password inside DATABASE_URL', () => {
    const masked = maskValue(
      'postgresql://db_owner:npg_Zy3KOBj1Atxv@db.example.com/testdb?sslmode=require',
    )
    expect(masked).toContain('db_owner:')
    expect(masked).toContain('@db.example.com/testdb')
    expect(masked).not.toContain('npg_Zy3KOBj1Atxv')
    expect(masked).toMatch(/:\w+\*+\w+@/)
  })

  it('masks token middle', () => {
    const tok = 'dt-' + 'a'.repeat(64)
    const masked = maskValue(tok)
    expect(masked.startsWith('dt-a')).toBe(true)
    expect(masked.endsWith('aaaa')).toBe(true)
    expect(masked).toContain('*')
    expect(masked).not.toBe(tok)
  })
})

describe('replaceEnvLine', () => {
  it('replaces only the matching line and keeps quotes', () => {
    const input = `# keep\nDATABASE_URL='old-url'\nDIGITAL_TWIN_TOKEN='dt-old'\n`
    const { content, oldValue } = replaceEnvLine(input, 'DATABASE_URL', 'new-url')
    expect(oldValue).toBe('old-url')
    expect(content).toBe(`# keep\nDATABASE_URL='new-url'\nDIGITAL_TWIN_TOKEN='dt-old'\n`)
  })

  it('throws when key missing', () => {
    expect(() => replaceEnvLine('FOO=1\n', 'DATABASE_URL', 'x')).toThrow(/Missing line/)
  })
})

describe('sslFromUrl', () => {
  it('disable → false (no TLS)', () => {
    expect(sslFromUrl('postgresql://u:p@db.example.com/db?sslmode=disable')).toBe(false)
  })

  it('require / missing → require (old default)', () => {
    expect(sslFromUrl('postgresql://u:p@db.example.com/db?sslmode=require')).toBe('require')
    expect(sslFromUrl('postgresql://u:p@db.example.com/db')).toBe('require')
  })
})
