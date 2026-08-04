import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseDotenvFile,
  readDotenvKey,
  upsertDotenvKey,
  writeFcEnvFile,
} from './dotenv-file'
import { maskValue } from './mask'

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function tmpFile(name: string, content = ''): string {
  const d = mkdtempSync(join(tmpdir(), 'dt-env-'))
  dirs.push(d)
  const p = join(d, name)
  writeFileSync(p, content)
  return p
}

describe('maskValue', () => {
  it('masks password inside DATABASE_URL', () => {
    const masked = maskValue(
      'postgresql://db_owner:npg_Zy3KOBj1Atxv@db.example.com/testdb?sslmode=require',
    )
    expect(masked).not.toContain('npg_Zy3KOBj1Atxv')
    expect(masked).toContain('@db.example.com/testdb')
  })
})

describe('dotenv-file', () => {
  it('reads quoted and JSON-quoted values', () => {
    const p = tmpFile(
      '.env',
      `A='hello'\nB="world"\nC=${JSON.stringify('x y')}\n`,
    )
    expect(readDotenvKey(p, 'A')).toBe('hello')
    expect(readDotenvKey(p, 'B')).toBe('world')
    expect(readDotenvKey(p, 'C')).toBe('x y')
    expect(readDotenvKey(p, 'Z')).toBe('')
  })

  it('upserts and parses full file', () => {
    const p = tmpFile('.env', `FOO=1\n`)
    upsertDotenvKey(p, 'FOO', '2')
    upsertDotenvKey(p, 'BAR', 'baz')
    expect(parseDotenvFile(p)).toEqual({ FOO: '2', BAR: 'baz' })
  })

  it('writeFcEnvFile round-trips', () => {
    const p = tmpFile('fc.env')
    writeFcEnvFile(p, { DATABASE_URL: 'postgresql://u:p@h/db', X: '' })
    expect(readDotenvKey(p, 'DATABASE_URL')).toBe('postgresql://u:p@h/db')
    expect(readDotenvKey(p, 'X')).toBe('')
  })
})
