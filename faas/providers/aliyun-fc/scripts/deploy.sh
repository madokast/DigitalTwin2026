#!/usr/bin/env bash
# 薄包装 → TypeScript。用法: ./scripts/deploy.sh test|prod
# 硬性规则仍在 deploy.ts：s deploy 输出必须丢弃。
set -euo pipefail
PROVIDER="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$PROVIDER/../../.." && pwd)"
cd "$REPO"
exec npx --yes tsx "$PROVIDER/scripts/deploy.ts" "$@"
