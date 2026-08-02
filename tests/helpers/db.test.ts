import { describe, expect, it } from 'vitest'
import { assertSafeTestDatabaseUrl } from './db'

describe('assertSafeTestDatabaseUrl', () => {
  it('accepts hostname containing test', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgresql://u:p@ep-test-pooler.example.com/neondb',
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
        'postgresql://u:p@ep-long-pine.example.com/neondb',
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
