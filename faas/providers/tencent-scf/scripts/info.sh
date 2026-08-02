#!/usr/bin/env bash
# 打印 SCF 部署信息（含 URL）。用法: ./scripts/info.sh test|prod
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${1:-test}"
if [[ "$STAGE" != "test" && "$STAGE" != "prod" ]]; then
  echo "usage: info.sh test|prod" >&2
  exit 1
fi
if ! command -v scf >/dev/null 2>&1 && ! command -v serverless-cloud-framework >/dev/null 2>&1; then
  echo "Missing scf CLI. npm i -g serverless-cloud-framework" >&2
  exit 1
fi
BIN="$(command -v scf || command -v serverless-cloud-framework)"
cd "$ROOT"
exec "$BIN" info --stage "$STAGE"
