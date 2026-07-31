#!/usr/bin/env bash
# 薄包装 → TypeScript。用法: ./scripts/deploy.sh test|prod
# 硬性规则仍在 deploy.ts：s deploy 输出必须丢弃。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
cd "$REPO"
exec npx --yes tsx "$ROOT/scripts/deploy.ts" "$@"
