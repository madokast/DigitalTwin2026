import { config } from 'dotenv'

// 始终以 .env 为准，避免 shell 里残留的旧 DATABASE_URL / Token 覆盖文件
config({ override: true })

// 显式测试态：notifyRecordInserted 以此跳过（即便后续 dotenv/config 写回 TELEGRAM_*）
process.env.DIGITAL_TWIN_TEST = '1'
delete process.env.TELEGRAM_ALLOW_IN_TEST

if (!process.env.DIGITAL_TWIN_TOKEN) {
  process.env.DIGITAL_TWIN_TOKEN = 'test-token-for-vitest'
}

if (!process.env.DIGITAL_TWIN_ADMIN_TOKEN) {
  process.env.DIGITAL_TWIN_ADMIN_TOKEN = 'test-admin-token-for-vitest'
}

// 尽量清空 Telegram；注意 src/db、src/lib/auth 的 import 'dotenv/config' 可能再次写入
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_USER_ID
