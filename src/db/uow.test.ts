import { beforeEach, describe, expect, it, vi } from 'vitest'

// 单测：mock @/db 单例，验证 UoW.do 包装 db.transaction（框架管理事务，UoW 只透传闭包）。
const fakeTx = { insert: vi.fn() }
const transaction = vi.fn(
  async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
)

vi.mock('@/db', () => ({
  default: {
    transaction: (...args: unknown[]) =>
      transaction(args[0] as (tx: unknown) => Promise<unknown>),
  },
}))

import db from '@/db'
import { UoW } from '@/db/uow'

describe('UoW.do', () => {
  beforeEach(() => {
    transaction.mockClear()
  })

  it('wraps db.transaction and passes tx executor to fn', async () => {
    const uow = new UoW(db)
    const seen: unknown[] = []
    const out = await uow.do(async (q) => {
      seen.push(q)
      return 'ok'
    })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([fakeTx])
    expect(out).toBe('ok')
  })

  it('propagates rejection from fn (rollback handled by drizzle)', async () => {
    const uow = new UoW(db)
    const boom = new Error('injected failure')
    transaction.mockImplementationOnce(async () => {
      throw boom
    })
    await expect(uow.do(async () => 'x')).rejects.toThrow('injected failure')
  })

  it('propagates fn error as-is when transaction rejects it', async () => {
    const uow = new UoW(db)
    const boom = new Error('fn failed')
    transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx).then(() => {
        throw boom
      }),
    )
    await expect(uow.do(async () => 'x')).rejects.toThrow('fn failed')
  })
})
