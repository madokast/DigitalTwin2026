import { config } from 'dotenv'

// 始终以 .env 为准，避免 shell 里残留的旧 DATABASE_URL / Token 覆盖文件
config({ override: true })

if (!process.env.DIGITAL_TWIN_TOKEN) {
  process.env.DIGITAL_TWIN_TOKEN = 'test-token-for-vitest'
}

if (!process.env.DIGITAL_TWIN_ADMIN_TOKEN) {
  process.env.DIGITAL_TWIN_ADMIN_TOKEN = 'test-admin-token-for-vitest'
}
