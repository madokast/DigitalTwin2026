#!/usr/bin/env bash
# 薄包装 → TypeScript。用法: npm run secrets:refresh-prod
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec npx --yes tsx "$ROOT/scripts/refresh-prod-env.ts" "$@"
