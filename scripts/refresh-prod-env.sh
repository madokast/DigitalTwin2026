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
    echo -n "输入 ${key}: " >&2
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
      echo "不能为空，请重试。" >&2
      continue
    fi
    echo "  预览: $(mask_value "$val")" >&2
    echo -n "确认？[y/N] " >&2
    local ok
    IFS= read -r ok
    if [[ "$ok" == [yY] || "$ok" == [yY][eE][sS] ]]; then
      printf '%s' "$val"
      return
    fi
    echo "重新输入。" >&2
  done
}

# 真实连库：select 1 + 可选检查 public.records（仅提示，不强制）
verify_database_url() {
  local url="$1"
  echo "正在校验 DATABASE_URL 可达性…" >&2
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
      console.error("warn: public.records 不存在，请确认已对生产库执行 npm run db:migrate");
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
    echo "DATABASE_URL 无法连接（错误摘要，不含连接串）：" >&2
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
    echo "连库失败，请重新输入 DATABASE_URL。" >&2
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

  echo "Vercel 写入 $key 失败：" >&2
  grep -vE 'postgresql://|postgres://|--value' "$err_file" | tail -20 >&2 || true
  rm -f "$err_file"
  return 1
}

preflight_vercel() {
  echo "检查 Vercel CLI…"
  if ! command -v vercel >/dev/null 2>&1; then
    echo "未找到 vercel 命令。请先: npm i -g vercel && vercel login" >&2
    exit 1
  fi
  local who
  if ! who="$(vercel whoami --cwd "$ROOT" 2>&1)"; then
    echo "Vercel 未登录或 token 无效：" >&2
    echo "$who" >&2
    echo "请执行: vercel login" >&2
    exit 1
  fi
  echo "  已登录: $who"
  if [[ ! -f "$ROOT/.vercel/project.json" ]]; then
    echo "本仓库尚未 link 到 Vercel 项目（缺少 .vercel/project.json）。" >&2
    echo "请在仓库根目录执行: vercel link" >&2
    echo "选中已有 DigitalTwin 生产项目后再重跑本脚本。" >&2
    exit 1
  fi
  echo "  已 link: $ROOT/.vercel/project.json"
}

preflight_s() {
  echo "检查 Serverless Devs (s / FC deploy)..."
  if ! command -v s >/dev/null 2>&1; then
    echo "未找到 s 命令。请安装: npm i -g @serverless-devs/s" >&2
    exit 1
  fi
  echo "  s: $(s -v 2>/dev/null | head -1 || echo ok)"

  local access
  access="$(awk '/^access:/{print $2; exit}' "$FC_DIR/s.yaml")"
  if [[ -z "$access" ]]; then
    echo "无法从 fc/s.yaml 读取 access 别名。" >&2
    exit 1
  fi
  echo "  s.yaml access: $access"

  local cfg
  if ! cfg="$(s config get -a "$access" 2>&1)"; then
    echo "s config 别名不可用: $access" >&2
    echo "$cfg" >&2
    echo "请执行: s config add  (别名填 $access)" >&2
    exit 1
  fi
  if ! printf '%s\n' "$cfg" | grep -q 'AccessKeyID'; then
    echo "s config 缺少 AccessKeyID，请重新 s config add。" >&2
    exit 1
  fi
  echo "  凭证: 已配置 ($access)"

  # Probe auth with s info (prod function may not exist yet)
  local info_err
  info_err="$(mktemp)"
  (
    cd "$FC_DIR"
    export DATABASE_URL="" DIGITAL_TWIN_TOKEN="" DIGITAL_TWIN_ADMIN_TOKEN=""
    s info --env prod
  ) >"$info_err" 2>&1 || true

  if grep -qiE 'invalid access key|AccessKeyId|403|Unauthorized|credential' "$info_err"; then
    echo "s / 阿里云鉴权失败:" >&2
    grep -iE 'Error|invalid|403|Unauthorized|Message' "$info_err" | head -8 >&2 || tail -5 "$info_err" >&2
    echo "请检查: s config get -a $access" >&2
    rm -f "$info_err"
    exit 1
  fi
  if grep -q 'digitaltwin-api-prod' "$info_err"; then
    echo "  FC prod 已存在 (可更新部署)"
  else
    echo "  FC prod 尚未部署 (本脚本将首次创建 digitaltwin-api-prod)"
  fi
  rm -f "$info_err"
}

cleanup_prod_env() {
  if [[ -f "$PROD_ENV_FILE" ]]; then
    rm -f "$PROD_ENV_FILE"
    echo "已删除临时文件 $PROD_ENV_FILE"
  fi
}

echo "=== 生产环境密钥刷新 (Vercel production + FC prod) ==="
echo "FC 若尚无 digitaltwin-api-prod，将临时写入 .env.fc.prod，部署后删除该文件。"
echo "禁止把下列值写入 git / 聊天记录。"
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

echo "汇总（已掩码）："
for key in "${KEYS[@]}"; do
  echo "  $key: $(mask_value "${VALUES[$key]}")"
done
echo
echo -n "将写入 Vercel production，并部署/更新 FC prod。继续？[y/N] "
IFS= read -r go
if [[ "$go" != [yY] && "$go" != [yY][eE][sS] ]]; then
  echo "已取消。"
  exit 0
fi

echo
echo "--- Vercel ---"
for key in "${KEYS[@]}"; do
  upsert_vercel_prod "$key" "${VALUES[$key]}"
done
echo "提示: 环境变量变更后将自动 vercel deploy --prod"
echo

echo "--- FC prod ---"
umask 077
trap cleanup_prod_env EXIT

{
  printf "DATABASE_URL='%s'\n" "${VALUES[DATABASE_URL]}"
  printf "DIGITAL_TWIN_TOKEN='%s'\n" "${VALUES[DIGITAL_TWIN_TOKEN]}"
  printf "DIGITAL_TWIN_ADMIN_TOKEN='%s'\n" "${VALUES[DIGITAL_TWIN_ADMIN_TOKEN]}"
} >"$PROD_ENV_FILE"
echo "已临时写入 $PROD_ENV_FILE（部署后删除）"

echo "部署 FC prod（s deploy 输出丢弃）…"
"$FC_DIR/scripts/deploy.sh" prod

echo
echo "--- Vercel Production 重新部署（使新 env 生效）---"
if vercel deploy --prod --yes --cwd "$ROOT"; then
  echo "Vercel production deploy OK."
else
  echo "Vercel deploy --prod 失败。env 已写入，可稍后手动: vercel deploy --prod" >&2
  exit 1
fi

echo
echo "完成。"
echo "FC Base URL: $("$FC_DIR/scripts/info.sh" prod 2>/dev/null || echo '(见 ./fc/scripts/info.sh prod)')"
echo "请在需要国内加速的浏览器设置里粘贴 FC URL；勿提交该 URL。"
