#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_TS="$ROOT_DIR/tools/notifications/telegram-delivery-guard.ts"
EXTERNAL_TS="/Users/hd/openclaw/tools/notifications/telegram-delivery-guard.ts"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

if ! command -v npx >/dev/null 2>&1; then
  echo "[telegram-delivery-guard] npx not found" >&2
  exit 1
fi

if [[ -f "$LOCAL_TS" ]]; then
  exec npx --yes tsx "$LOCAL_TS" "$@"
fi

if [[ -f "$EXTERNAL_TS" ]]; then
  exec npx --yes tsx "$EXTERNAL_TS" "$@"
fi

echo "[telegram-delivery-guard] missing script (checked $LOCAL_TS and $EXTERNAL_TS)" >&2
exit 1
