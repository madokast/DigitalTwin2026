import { config } from 'dotenv'

config()

if (!process.env.DIGITAL_TWIN_TOKEN) {
  process.env.DIGITAL_TWIN_TOKEN = 'test-token-for-vitest'
}

if (!process.env.DIGITAL_TWIN_ADMIN_TOKEN) {
  process.env.DIGITAL_TWIN_ADMIN_TOKEN = 'test-admin-token-for-vitest'
}
