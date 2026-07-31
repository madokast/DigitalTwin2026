#!/usr/bin/env bash
# 用法: ./scripts/deploy.sh test|prod
# 前置: s config add 已完成；fc/.env.fc.<env> 含 DATABASE_URL 与两个 Token
#
# 硬性规则：禁止让 `s deploy` 的 stdout/stderr 进终端或日志。
# Serverless Devs 会把 environmentVariables（含 DATABASE_URL / Token）明文打印。
# 必须整段重定向到 /dev/null（或等价丢弃）；成功与否只看 exit code。
# 取 HTTP URL 用单独的 `s info`（勿把含密钥的 deploy 日志存盘）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-}"

if [[ "$ENV_NAME" != "test" && "$ENV_NAME" != "prod" ]]; then
  echo "usage: $0 test|prod" >&2
  exit 1
fi

ENV_FILE="$ROOT/.env.fc.$ENV_NAME"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — copy from env.fc.example and fill secrets" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${DATABASE_URL:?DATABASE_URL required in $ENV_FILE}"
: "${DIGITAL_TWIN_TOKEN:?DIGITAL_TWIN_TOKEN required in $ENV_FILE}"
: "${DIGITAL_TWIN_ADMIN_TOKEN:?DIGITAL_TWIN_ADMIN_TOKEN required in $ENV_FILE}"

cd "$ROOT"
echo "deploying env=$ENV_NAME (s deploy output discarded — secrets must not print)"

if ! s deploy --env "$ENV_NAME" -y >/dev/null 2>&1; then
  echo "deploy FAILED (env=$ENV_NAME). Re-run only via this script; do not run bare s deploy." >&2
  exit 1
fi

echo "deploy OK."
url="$("$ROOT/scripts/info.sh" "$ENV_NAME" 2>/dev/null || true)"
if [[ -n "${url:-}" ]]; then
  echo "HTTP Base URL: $url"
  echo "Paste into Settings → API 加速地址 (never commit)."
else
  echo "Get HTTP URL with: ./scripts/info.sh $ENV_NAME"
fi
echo "Do NOT run: s deploy   (leaks env secrets to the terminal)"
