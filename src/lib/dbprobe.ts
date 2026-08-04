/**
 * 短命 DB 探测：独立连接测 connect / 两次 select 1 / public.records 是否存在。
 * 与 Go `faas/internal/dbprobe` 同构；不查 __drizzle_migrations。
 */
import postgres from 'postgres'

export type DbProbeResult = {
  ok: boolean
  database_reachable: true
  records_table_exists: boolean
  connect_ms: number
  select1_first_ms: number
  select1_second_ms: number
}

export type DbProbeFailure = {
  error: string
  status: 503
}

export const DATABASE_URL_NOT_SET = 'DATABASE_URL is not set'
export const DATABASE_UNREACHABLE = 'Database unreachable'

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10
}

/** 错误文案不得回显连接串 */
export function sanitizeProbeError(_err: unknown): string {
  void _err
  return DATABASE_UNREACHABLE
}

type SqlFactory = typeof postgres

/**
 * 打开短命连接，测三段延迟与 public.records。
 * @param getenv 可注入（单测）；默认读 process.env
 * @param createSql 可注入 postgres 工厂（单测）
 */
export async function probeDatabase(
  getenv: (key: string) => string | undefined = (k) => process.env[k],
  createSql: SqlFactory = postgres,
): Promise<DbProbeResult | DbProbeFailure> {
  const url = getenv('DATABASE_URL')?.trim()
  if (!url) {
    return { error: DATABASE_URL_NOT_SET, status: 503 }
  }

  const pool = createSql(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 5,
  })

  try {
    const tConnect = performance.now()
    const conn = await pool.reserve()
    const connectMs = roundMs(performance.now() - tConnect)

    try {
      const t1 = performance.now()
      await conn`select 1 as ok`
      const select1FirstMs = roundMs(performance.now() - t1)

      const t2 = performance.now()
      await conn`select 1 as ok`
      const select1SecondMs = roundMs(performance.now() - t2)

      const rows = await conn`
        select to_regclass('public.records')::text as t
      `
      const recordsTableExists = Boolean(rows[0]?.t)

      return {
        ok: recordsTableExists,
        database_reachable: true,
        records_table_exists: recordsTableExists,
        connect_ms: connectMs,
        select1_first_ms: select1FirstMs,
        select1_second_ms: select1SecondMs,
      }
    } finally {
      conn.release()
    }
  } catch (err) {
    return { error: sanitizeProbeError(err), status: 503 }
  } finally {
    await pool.end({ timeout: 5 }).catch(() => {})
  }
}
