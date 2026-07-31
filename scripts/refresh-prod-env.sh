#!/usr/bin/env bash
# 交互式刷新「生产」环境变量：Vercel production + 阿里云 FC prod（首次会部署 digitaltwin-api-prod）。
#
# 用法（在仓库根目录）:
#   ./scripts/refresh-prod-env.sh
#
# 要求: 已 vercel link；s config（fc/s.yaml 的 access）可用；勿把输入的密钥提交 git。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FC_DIR="$ROOT/fc"
PROD_ENV_FILE="$FC_DIR/.env.fc.prod"
KEYS=(DATABASE_URL DIGITAL_TWIN_TOKEN DIGITAL_TWIN_ADMIN_TOKEN)

mask_middle() {
  local v="$1" head=4 tail=4
  local n=${#v}
  if (( n <= head + tail )); then
    printf '%s' "$(printf '%*s' "$n" '' | tr ' ' '*')"
    return
  fi
  local stars=$(( n - head - tail ))
  (( stars > 16 )) && stars=16
  (( stars < 6 )) && stars=6
  printf '%s%s%s' "${v:0:head}" "$(printf '%*s' "$stars" '' | tr ' ' '*')" "${v: -tail}"
}

mask_value() {
  local raw="$1"
  if [[ "$raw" == postgresql://* ]] || [[ "$raw" == postgres://* ]]; then
    # 只掩码 userinfo 里的密码段
    local rest="${raw#*://}"
    local userpass="${rest%%@*}"
    local hostpath="${rest#*@}"
    local user="${userpass%%:*}"
    local pass="${userpass#*:}"
    if [[ "$userpass" == *:* ]]; then
      printf '%s' "postgresql://${user}:$(mask_middle "$pass")@${hostpath}"
      return
    fi
  fi
  mask_middle "$raw"
}

prompt_secret() {
  local key="$1"
  local val=""
  while true; do
    echo -n "Enter ${key}: " >&2
    # DATABASE_URL 较长，回显关闭以免 scrollback；两端 trim
    IFS= read -r -s val
    echo >&2
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    # 去掉误粘贴的成对引号
    if [[ "$val" == \'*\' || "$val" == \"*\" ]]; then
      val="${val:1:-1}"
    fi
    if [[ -z "$val" ]]; then
      echo "Cannot be empty, please try again." >&2
      continue
    fi
    echo "  Preview: $(mask_value "$val")" >&2
    echo -n "Confirm? [y/N] " >&2
    local ok
    IFS= read -r ok
    if [[ "$ok" == [yY] || "$ok" == [yY][eE][sS] ]]; then
      printf '%s' "$val"
      return
    fi
    echo "Try again." >&2
  done
}

# 真实连库：select 1 + 可选检查 public.records（仅提示，不强制）
verify_database_url() {
  local url="$1"
  echo "Verifying DATABASE_URL connectivity..." >&2
  local err_file
  err_file="$(mktemp)"
  if ! (
    cd "$ROOT"
    export DATABASE_URL="$url"
    npx --yes tsx -e '
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL empty");
const sql = postgres(url, { max: 1, ssl: "require", connect_timeout: 15 });
(async () => {
  try {
    await sql`select 1 as ok`;
    const r = await sql`select to_regclass('\''public.records'\'')::text as t`;
    if (!r[0]?.t) {
      console.error("warn: public.records does not exist; confirm you ran npm run db:migrate on production");
    } else {
      console.error("ok: connected, public.records exists");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
' 2>"$err_file"
  ); then
    echo "DATABASE_URL unreachable (error summary, connection string omitted):" >&2
    # 去掉可能回显 URL 的行
    grep -vE 'postgresql://|postgres://|DATABASE_URL=' "$err_file" | tail -8 >&2 || true
    rm -f "$err_file"
    return 1
  fi
  # 把 tsx 的 console.error 提示打出来
  grep -E '^(ok:|warn:)' "$err_file" >&2 || cat "$err_file" >&2 || true
  rm -f "$err_file"
  return 0
}

prompt_database_url() {
  while true; do
    local val
    val="$(prompt_secret DATABASE_URL)"
    if verify_database_url "$val"; then
      printf '%s' "$val"
      return
    fi
    echo "Connection failed, please re-enter DATABASE_URL." >&2
    echo >&2
  done
}

upsert_vercel_prod() {
  local key="$1" value="$2"
  local err_file
  err_file="$(mktemp)"

  # 1) 尝试原地 update（单环境变量时常成功）
  if vercel env update "$key" production --value "$value" --sensitive -y --cwd "$ROOT" >"$err_file" 2>&1; then
    echo "Vercel production: updated $key"
    rm -f "$err_file"
    return
  fi

  # 2) add --force（覆盖「已存在」）
  if vercel env add "$key" production --value "$value" --sensitive --force -y --cwd "$ROOT" >"$err_file" 2>&1; then
    echo "Vercel production: upserted $key (--force)"
    rm -f "$err_file"
    return
  fi

  # 3) 多环境共用条目（如 production+preview）时 update/add 会报 already exists：
  #    先删掉该名下全部环境，再只写回 production
  vercel env rm "$key" -y --cwd "$ROOT" >"$err_file" 2>&1 || true
  if vercel env add "$key" production --value "$value" --sensitive -y --cwd "$ROOT" >"$err_file" 2>&1; then
    echo "Vercel production: replaced $key (removed old multi-env entry first)"
    # 若你仍要 Preview 也有同名变量，可手动 vercel env add … preview
    rm -f "$err_file"
    return
  fi

  echo "Failed to write Vercel $key:" >&2
  grep -vE 'postgresql://|postgres://|--value' "$err_file" | tail -20 >&2 || true
  rm -f "$err_file"
  return 1
}

preflight_vercel() {
  echo "Checking Vercel CLI..."
  if ! command -v vercel >/dev/null 2>&1; then
    echo "vercel command not found. Run: npm i -g vercel && vercel login" >&2
    exit 1
  fi
  local who
  if ! who="$(vercel whoami --cwd "$ROOT" 2>&1)"; then
    echo "Vercel not logged in or token invalid:" >&2
    echo "$who" >&2
    echo "Run: vercel login" >&2
    exit 1
  fi
  echo "  Logged in as: $who"
  if [[ ! -f "$ROOT/.vercel/project.json" ]]; then
    echo "This repo is not linked to a Vercel project (missing .vercel/project.json)." >&2
    echo "Run vercel link from the repo root." >&2
    echo "Select the existing DigitalTwin production project, then re-run this script." >&2
    exit 1
  fi
  echo "  Linked: $ROOT/.vercel/project.json"
}

preflight_s() {
  echo "Checking Serverless Devs (s / FC deploy)..."
  if ! command -v s >/dev/null 2>&1; then
    echo "s command not found. Install: npm i -g @serverless-devs/s" >&2
    exit 1
  fi
  echo "  s: $(s -v 2>/dev/null | head -1 || echo ok)"

  local access
  access="$(awk '/^access:/{print $2; exit}' "$FC_DIR/s.yaml")"
  if [[ -z "$access" ]]; then
    echo "Cannot read access alias from fc/s.yaml." >&2
    exit 1
  fi
  echo "  s.yaml access: $access"

  local cfg
  if ! cfg="$(s config get -a "$access" 2>&1)"; then
    echo "s config alias unavailable: $access" >&2
    echo "$cfg" >&2
    echo "Run: s config add (alias: $access)" >&2
    exit 1
  fi
  if ! printf '%s\n' "$cfg" | grep -q 'AccessKeyID'; then
    echo "s config missing AccessKeyID; re-run s config add." >&2
    exit 1
  fi
  echo "  Credentials: configured ($access)"

  # Probe auth with s info (prod function may not exist yet)
  local info_err
  info_err="$(mktemp)"
  (
    cd "$FC_DIR"
    export DATABASE_URL="" DIGITAL_TWIN_TOKEN="" DIGITAL_TWIN_ADMIN_TOKEN=""
    s info --env prod
  ) >"$info_err" 2>&1 || true

  if grep -qiE 'invalid access key|AccessKeyId|403|Unauthorized|credential' "$info_err"; then
    echo "s / Alibaba Cloud auth failed:" >&2
    grep -iE 'Error|invalid|403|Unauthorized|Message' "$info_err" | head -8 >&2 || tail -5 "$info_err" >&2
    echo "Check: s config get -a $access" >&2
    rm -f "$info_err"
    exit 1
  fi
  if grep -q 'digitaltwin-api-prod' "$info_err"; then
    echo "  FC prod exists (can update deploy)"
  else
    echo "  FC prod not deployed yet (this script will create digitaltwin-api-prod)"
  fi
  rm -f "$info_err"
}

cleanup_prod_env() {
  if [[ -f "$PROD_ENV_FILE" ]]; then
    rm -f "$PROD_ENV_FILE"
    echo "Deleted temp file $PROD_ENV_FILE"
  fi
}

echo "=== Refresh production secrets (Vercel production + FC prod) ==="
echo "If digitaltwin-api-prod does not exist, temporarily writes .env.fc.prod; deleted after deploy."
echo "Do NOT commit these values to git or paste in chat logs."
echo
preflight_vercel
echo
preflight_s
echo

declare -A VALUES=()
VALUES[DATABASE_URL]="$(prompt_database_url)"
echo
VALUES[DIGITAL_TWIN_TOKEN]="$(prompt_secret DIGITAL_TWIN_TOKEN)"
echo
VALUES[DIGITAL_TWIN_ADMIN_TOKEN]="$(prompt_secret DIGITAL_TWIN_ADMIN_TOKEN)"
echo

echo "Summary (masked):"
for key in "${KEYS[@]}"; do
  echo "  $key: $(mask_value "${VALUES[$key]}")"
done
echo
echo -n "Will write Vercel production and deploy/update FC prod. Continue? [y/N] "
IFS= read -r go
if [[ "$go" != [yY] && "$go" != [yY][eE][sS] ]]; then
  echo "Cancelled."
  exit 0
fi

echo
echo "--- Vercel ---"
for key in "${KEYS[@]}"; do
  upsert_vercel_prod "$key" "${VALUES[$key]}"
done
echo "Note: will run vercel deploy --prod after env changes"
echo

echo "--- FC prod ---"
umask 077
trap cleanup_prod_env EXIT

{
  printf "DATABASE_URL='%s'\n" "${VALUES[DATABASE_URL]}"
  printf "DIGITAL_TWIN_TOKEN='%s'\n" "${VALUES[DIGITAL_TWIN_TOKEN]}"
  printf "DIGITAL_TWIN_ADMIN_TOKEN='%s'\n" "${VALUES[DIGITAL_TWIN_ADMIN_TOKEN]}"
} >"$PROD_ENV_FILE"
echo "Temporarily wrote $PROD_ENV_FILE (deleted after deploy)"

echo "Deploying FC prod (s deploy output discarded)..."
"$FC_DIR/scripts/deploy.sh" prod

echo
echo "--- Redeploy Vercel Production (apply new env) ---"
if vercel deploy --prod --yes --cwd "$ROOT"; then
  echo "Vercel production deploy OK."
else
  echo "Vercel deploy --prod failed. Env was written; retry manually: vercel deploy --prod" >&2
  exit 1
fi

echo
echo "Done."
echo "FC Base URL: $("$FC_DIR/scripts/info.sh" prod 2>/dev/null || echo '(see ./fc/scripts/info.sh prod)')"
echo "Paste FC URL into Settings → API Accelerate URL in browsers that need China acceleration; never commit it."
