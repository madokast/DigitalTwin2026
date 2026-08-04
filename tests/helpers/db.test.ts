import { describe, expect, it } from 'vitest'
import { assertSafeTestDatabaseUrl } from './db'

describe('assertSafeTestDatabaseUrl', () => {
  it('accepts hostname containing test', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgresql://u:p@db-test.example.com/appdb',
      ),
    ).not.toThrow()
  })

  it('accepts database name containing test', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgresql://u:p@ep-long-pine.example.com/my_test_db',
      ),
    ).not.toThrow()
  })

  it('accepts TestDigitalTwin in database name', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgresql://u:p@ep.example.com/TestDigitalTwin',
      ),
    ).not.toThrow()
  })

  it('rejects production-looking URL without test markers', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgresql://u:p@db.example.com/proddb',
      ),
    ).toThrow(/must contain "test"/i)
  })

  it('rejects when only username contains test', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgresql://testuser:p@db.example.com/proddb',
      ),
    ).toThrow(/must contain "test"/i)
  })

  it('rejects empty URL', () => {
    expect(() => assertSafeTestDatabaseUrl('  ')).toThrow(/empty/i)
  })

  it('rejects invalid URL', () => {
    expect(() => assertSafeTestDatabaseUrl('not-a-url')).toThrow(/valid URL/i)
  })
})
