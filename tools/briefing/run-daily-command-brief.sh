#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="/tmp/daily-command-brief.txt"
GUARD="$ROOT/tools/notifications/telegram-delivery-guard.sh"
GEN=(npx tsx "$ROOT/tools/briefing/daily-command-brief.ts")

if [[ "${1:-}" == "--dry-run" ]]; then
  "${GEN[@]}" --dry-run
  exit 0
fi

if ! "${GEN[@]}" > "$OUT"; then
  "$GUARD" "Generation failed. Check /tmp/daily-command-brief.log" 8171372724 0 daily_command_brief_error "daily-command-brief-error-$(date +%F)" P1 monitor Brief now cron-maintenance
  exit 1
fi

if ! "$GUARD" "$(cat "$OUT")" 8171372724 0 daily_command_brief "daily-command-brief-$(date +%F)" P2 monitor Brief summary cron-maintenance; then
  "$GUARD" "Telegram delivery failed after retries." 8171372724 0 daily_command_brief_error "daily-command-brief-delivery-error-$(date +%F)" P1 monitor Brief now cron-maintenance
  exit 1
fi

echo "daily-command-brief sent"
