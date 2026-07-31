#!/usr/bin/env bash
# 打印 FC HTTP Base URL（不含密钥）。用法: ./scripts/info.sh test|prod
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-test}"

if [[ "$ENV_NAME" != "test" && "$ENV_NAME" != "prod" ]]; then
  echo "usage: $0 test|prod" >&2
  exit 1
fi

# 若有本地密钥文件则加载（s info 解析 yaml 时可能仍引用 env）；没有也能跑（yaml 已给空默认）
ENV_FILE="$ROOT/.env.fc.$ENV_NAME"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd "$ROOT"
# 只抽出公网 URL，避免整段 info 里夹杂其它敏感字段
out="$(s info --env "$ENV_NAME" 2>/dev/null || s info --env "$ENV_NAME")"
url="$(printf '%s\n' "$out" | grep -oE 'https://[^[:space:]]+\.fcapp\.run' | grep -v vpc | head -1 || true)"
if [[ -z "$url" ]]; then
  echo "Could not parse system_url. Full output:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
echo "$url"
