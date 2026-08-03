import { loadTestEnv } from '../scripts/lib/test-env'

// 始终以 .env.test 为准，避免 shell 里残留的旧 DATABASE_URL / Token 覆盖文件
loadTestEnv({ override: true })

// 业务 notify_user 静音（与 .env.test 双保险；probe 不受此约束）
process.env.SUPPRESS_BOT_NOTIFICATION = '1'

// 集成测门闸只认 DATABASE_URL（须通过 assertSafeTestDatabaseUrl）

if (!process.env.DIGITAL_TWIN_TOKEN) {
  process.env.DIGITAL_TWIN_TOKEN = 'test-token-for-vitest'
}

if (!process.env.DIGITAL_TWIN_ADMIN_TOKEN) {
  process.env.DIGITAL_TWIN_ADMIN_TOKEN = 'test-admin-token-for-vitest'
}

// 尽量清空通知渠道；注意 src/db、src/lib/auth 的 loadTestEnv 可能再次写入
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_USER_ID
delete process.env.QQBOT_APP_ID
delete process.env.QQBOT_APP_SECRET
delete process.env.QQBOT_USER_OPENID
