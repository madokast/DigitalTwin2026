/**
 * 已废弃：请改用 `npm run deploy -- prod`（内调 collect-prod-env）。
 */
console.error(
  'secrets:refresh-prod is removed. Use:\n' +
    '  npm run deploy -- prod\n' +
    '(collects secrets via scripts/collect-prod-env.ts → temporary .env.prod, then Vercel + optional FC/SCF)',
)
process.exit(1)
