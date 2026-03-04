#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]-$0}"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")/../.." && pwd)"
LOCAL_TS="$ROOT_DIR/tools/task-board/aggressive-reconcile.ts"

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

if ! command -v npx >/dev/null 2>&1; then
  echo "[aggressive-reconcile] npx not found" >&2
  exit 1
fi

if [[ ! -f "$LOCAL_TS" ]]; then
  echo "[aggressive-reconcile] missing script: $LOCAL_TS" >&2
  exit 1
fi

exec npx --yes tsx "$LOCAL_TS" "$@"
