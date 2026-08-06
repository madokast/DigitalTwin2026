import { describe, expect, it } from 'vitest'
import { MyError, newInternal, newValidation } from '@/lib/myerr'

describe('myerr.newInternal', () => {
  it('describe: type name + driver message for 500 detail', () => {
    const me = newInternal(new Error('ERROR: relation "records" does not exist (SQLSTATE 42P01)'))
    expect(me.status).toBe(500)
    expect(me.message).toContain('Error: ERROR: relation "records" does not exist')
  })

  it('empty message falls back to type name (never empty)', () => {
    const me = newInternal(new Error(''))
    expect(me.message).toBe('Error')
  })

  it('short-circuits when already a MyError (no double wrapping)', () => {
    const orig = newValidation('missing required field: raw_content')
    const me = newInternal(orig)
    expect(me).toBe(orig)
    expect(me.message).toBe('missing required field: raw_content')
  })

  it('isNotFound semantic equality', () => {
    const me = new MyError(404, 'record x not found')
    expect(me.isNotFound()).toBe(true)
    expect(newValidation('x').isNotFound()).toBe(false)
  })
})
