#!/usr/bin/env bash
# 薄包装 → deploy.ts。用法: ./scripts/deploy.sh --env-file <path>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../../.." && pwd)"
exec npx --yes tsx "$ROOT/scripts/deploy.ts" "$@"
