#!/usr/bin/env bash
set -euo pipefail

# Args expected by callers (e.g. subagent-watchdog):
# 1: message text
# 2: telegram target (default 8171372724)
# 3: reserved (ignored)
# 4: alert_type (optional)
# 5: dedupe key (optional)

MSG="${1:-}"
TARGET="${2:-8171372724}"
ALERT_TYPE="${4:-generic_alert}"
DEDUPE_KEY="${5:-}"

if [[ -z "$MSG" ]]; then
  echo "[telegram-delivery-guard] missing message argument" >&2
  exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "[telegram-delivery-guard] openclaw CLI not found" >&2
  exit 1
fi

# Optional lightweight dedupe: if key provided, suppress repeats within 5 minutes.
if [[ -n "$DEDUPE_KEY" ]]; then
  DEDUPE_DIR="${HOME}/.openclaw/tmp/telegram-guard"
  mkdir -p "$DEDUPE_DIR"
  SAFE_KEY="$(echo "$DEDUPE_KEY" | tr -cs 'A-Za-z0-9._-' '_')"
  MARKER="$DEDUPE_DIR/${SAFE_KEY}.ts"
  NOW="$(date +%s)"
  if [[ -f "$MARKER" ]]; then
    LAST="$(cat "$MARKER" 2>/dev/null || echo 0)"
    if [[ $((NOW - LAST)) -lt 300 ]]; then
      echo "[telegram-delivery-guard] deduped ($ALERT_TYPE) key=$DEDUPE_KEY"
      exit 0
    fi
  fi
  echo "$NOW" > "$MARKER"
fi

openclaw message send --channel telegram --target "$TARGET" --message "$MSG" --json >/dev/null

echo "[telegram-delivery-guard] sent ($ALERT_TYPE) to $TARGET"
