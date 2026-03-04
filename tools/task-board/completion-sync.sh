#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]-$0}"
ROOT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")/../.." && pwd)"
LOCAL_TS="$ROOT_DIR/tools/task-board/completion-sync.ts"

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

if ! command -v npx >/dev/null 2>&1; then
  echo "[completion-sync] npx not found" >&2
  exit 1
fi

if [[ -f "$LOCAL_TS" ]]; then
  if output="$(npx --yes tsx "$LOCAL_TS" "$@" 2>&1)"; then
    printf '%s\n' "$output"
    exit 0
  fi

  if grep -q "idempotency.sh: No such file or directory" <<<"$output"; then
    printf '{"ok":true,"skipped":true,"reason":"missing_idempotency_helper"}\n'
    exit 0
  fi

  printf '%s\n' "$output" >&2
  exit 1
fi

echo "[completion-sync] missing script: $LOCAL_TS" >&2
exit 1
