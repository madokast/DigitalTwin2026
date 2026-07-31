import { describe, expect, it } from 'vitest'
import { maskValue, replaceEnvLine } from './rotate-test-secrets'

describe('maskValue', () => {
  it('masks password inside DATABASE_URL', () => {
    const masked = maskValue(
      'postgresql://neondb_owner:npg_Zy3KOBj1Atxv@ep.example.com/neondb?sslmode=require',
    )
    expect(masked).toContain('neondb_owner:')
    expect(masked).toContain('@ep.example.com/neondb')
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
