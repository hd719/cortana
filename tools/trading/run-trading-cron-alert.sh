#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_FILE="/tmp/trading-cron-alert.txt"
SEND_STDOUT="/tmp/trading-cron-alert-send.out"
SEND_STDERR="/tmp/trading-cron-alert-send.err"
TARGET="8171372724"
MAX_RETRIES=3
RUNNER=(node --import tsx ./tools/trading/trading-cron-alert.ts)

cd "$ROOT_DIR"

send_message() {
  local message="$1"
  local attempt=1
  local delay=1

  while (( attempt <= MAX_RETRIES )); do
    if openclaw message send --channel telegram --target "$TARGET" --message "$message" --json >"$SEND_STDOUT" 2>"$SEND_STDERR"; then
      return 0
    fi

    if (( attempt == MAX_RETRIES )); then
      return 1
    fi

    sleep "$delay"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done

  return 1
}

if [[ "${1:-}" == "--dry-run" ]]; then
  exec "${RUNNER[@]}"
fi

if ! "${RUNNER[@]}" >"$OUT_FILE"; then
  alert_text="$(tr -d '\r' <"$OUT_FILE" 2>/dev/null || true)"
  if [[ -z "$alert_text" ]]; then
    alert_text="📈 Trading Advisor - Error: unified market-session runner failed"
  fi

  send_message "$alert_text" || true
  printf '%s\n' "$alert_text" >&2
  exit 1
fi

alert_text="$(tr -d '\r' <"$OUT_FILE")"
if [[ -z "$alert_text" ]]; then
  echo "📈 Trading Advisor - Error: unified market-session runner produced empty output" >&2
  exit 1
fi

if ! send_message "$alert_text"; then
  echo "📈 Trading Advisor - Error: Telegram delivery failed after retries." >&2
  exit 1
fi

echo "trading-cron-alert sent"
