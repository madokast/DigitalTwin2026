import { loadTestEnv } from './scripts/lib/test-env'

// override:false：壳层已设 DATABASE_URL（如 collect-prod-env / 显式导出）优先；否则用 .env.test
loadTestEnv({ override: false })
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
