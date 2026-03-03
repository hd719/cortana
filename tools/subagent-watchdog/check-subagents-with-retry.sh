#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD=(npx --yes tsx "$ROOT_DIR/tools/subagent-watchdog/check-subagents.ts" "$@")

if "${CMD[@]}"; then
  exit 0
fi

# Retry once on failure/abort-like behavior
sleep 2
if "${CMD[@]}"; then
  echo "[subagent-reliability] recovered_after_retry=true"
  exit 0
fi

echo "[subagent-reliability] fallback_manual_required=true" >&2
exit 1
