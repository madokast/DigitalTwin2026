/**
 * 校验 DATABASE_URL 可达；错误摘要不打印连接串。
 */
import postgres from 'postgres'

export async function verifyDatabaseUrl(url: string): Promise<boolean> {
  console.error('Verifying DATABASE_URL connectivity...')
  const sql = postgres(url, { max: 1, ssl: 'require', connect_timeout: 15 })
  try {
    await sql`select 1 as ok`
    const r = await sql`select to_regclass('public.records')::text as t`
    if (!r[0]?.t) {
      console.error(
        'warn: public.records does not exist; confirm you ran npm run db:migrate on production',
      )
    } else {
      console.error('ok: connected, public.records exists')
    }
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const safe = msg
      .split('\n')
      .filter((l) => !/postgresql:\/\/|postgres:\/\/|DATABASE_URL=/.test(l))
      .slice(-8)
      .join('\n')
    console.error(
      'DATABASE_URL unreachable (error summary, connection string omitted):',
    )
    console.error(safe || msg)
    return false
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}
