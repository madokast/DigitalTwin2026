#!/usr/bin/env bash
# 在本 provider 目录发起 scf login，终端会打印登录链接 / 二维码。
# 把链接发给操作者在浏览器或微信中完成授权即可。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v scf >/dev/null 2>&1 && ! command -v serverless-cloud-framework >/dev/null 2>&1; then
  echo "Missing scf CLI. Install: npm i -g serverless-cloud-framework" >&2
  echo "Docs: https://cloud.tencent.com/document/product/1154/50938" >&2
  exit 1
fi
BIN="$(command -v scf || command -v serverless-cloud-framework)"
cd "$ROOT"
echo "Running: $BIN login (watch for https://slslogin.qcloud.com/... )" >&2
exec "$BIN" login
