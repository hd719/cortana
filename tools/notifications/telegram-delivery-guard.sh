#!/usr/bin/env bash
set -u

# README
# ======
# telegram-delivery-guard.sh
# Reliable Telegram delivery wrapper for cron/alert scripts.
#
# Usage:
#   telegram-delivery-guard.sh "message text"
#   telegram-delivery-guard.sh "message text" 8171372724 Markdown
#   ALERT_TYPE=morning_brief telegram-delivery-guard.sh "message text"
#   telegram-delivery-guard.sh "message text" 8171372724 Markdown morning_brief alert-key-123
#   telegram-delivery-guard.sh "message text" 8171372724 Markdown morning_brief alert-key-123 <intent_id>
#
# Args:
#   1) message text (required)
#   2) chat_id (optional, default: 8171372724)
#   3) parse_mode (optional; accepted for compatibility)
#   4) alert_type (optional, default: generic)
#   5) alert_key (optional, default: epoch_ms)
#   6) intent_id (optional; if omitted, an alert_intent is emitted automatically)
#
# Behavior:
#   - Emits/uses alert intent and includes intent_id in delivery logs
#   - Sends message via: openclaw message send --channel telegram --target <chat_id>
#   - Validates success (exit code + non-empty response, no obvious error markers)
#   - Retries once after 3 seconds on failure
#   - Logs delivery status to cortana_events as event_type='alert_delivery'
#   - If second attempt fails, also logs delivery_failure warning
#   - Exit codes:
#       0 = delivered
#       1 = failed after retry

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

DEFAULT_CHAT_ID="8171372724"
DB_NAME="${CORTANA_DB:-cortana}"
SOURCE="telegram-delivery-guard"
INTENT_EMITTER="${ALERT_INTENT_EMITTER:-/Users/hd/clawd/tools/alerting/emit-alert-intent.sh}"

MESSAGE_TEXT="${1:-}"
CHAT_ID="${2:-$DEFAULT_CHAT_ID}"
PARSE_MODE="${3:-}"
ALERT_TYPE="${4:-${ALERT_TYPE:-generic}}"
ALERT_KEY="${5:-${ALERT_KEY:-$(date +%s%3N)}}"
INTENT_ID="${6:-${ALERT_INTENT_ID:-}}"

if [[ -z "$MESSAGE_TEXT" ]]; then
  echo "Usage: $(basename "$0") \"message text\" [chat_id] [parse_mode] [alert_type] [alert_key] [intent_id]" >&2
  exit 1
fi

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

ensure_intent_id() {
  if [[ -n "$INTENT_ID" ]]; then
    return 0
  fi

  if [[ ! -x "$INTENT_EMITTER" ]]; then
    return 0
  fi

  local expected_ts emit_json
  expected_ts="$(/usr/bin/python3 - <<'PY'
from datetime import datetime, timedelta, timezone
import os
sec=int(os.environ.get('ALERT_EXPECTED_DELIVERY_SECONDS','120'))
print((datetime.now(timezone.utc)+timedelta(seconds=sec)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)"

  emit_json="$($INTENT_EMITTER "$ALERT_TYPE" "telegram" "$expected_ts" 2>/dev/null || true)"
  if [[ -n "${emit_json//[[:space:]]/}" ]]; then
    INTENT_ID="$(printf "%s" "$emit_json" | /usr/bin/python3 -c 'import json,sys
try:
 d=json.load(sys.stdin)
 print(d.get("intent_id",""))
except Exception:
 print("")')"
  fi
}

log_alert_delivery() {
  local status="$1"
  local attempt_count="$2"
  local detail="${3:-}"
  local esc_msg esc_meta
  esc_msg="$(sql_escape "Alert delivery ${status}: type=${ALERT_TYPE}, key=${ALERT_KEY}, intent_id=${INTENT_ID}")"
  esc_meta="$(sql_escape "{\"chat_id\":\"${CHAT_ID}\",\"parse_mode\":\"${PARSE_MODE}\",\"alert_type\":\"${ALERT_TYPE}\",\"alert_key\":\"${ALERT_KEY}\",\"intent_id\":\"${INTENT_ID}\",\"status\":\"${status}\",\"attempts\":${attempt_count},\"detail\":\"$(sql_escape "${detail}")\"}")"

  psql "$DB_NAME" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('alert_delivery', '$SOURCE', 'info', '$esc_msg', '$esc_meta'::jsonb);" >/dev/null 2>&1 || true
}

log_delivery_failure() {
  local detail="$1"
  local esc_msg esc_meta
  esc_msg="$(sql_escape "Telegram delivery failed after retry: ${detail}")"
  esc_meta="$(sql_escape "{\"chat_id\":\"${CHAT_ID}\",\"parse_mode\":\"${PARSE_MODE}\",\"alert_type\":\"${ALERT_TYPE}\",\"alert_key\":\"${ALERT_KEY}\",\"intent_id\":\"${INTENT_ID}\"}")"

  psql "$DB_NAME" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('delivery_failure', '$SOURCE', 'warning', '$esc_msg', '$esc_meta'::jsonb);" >/dev/null 2>&1 || true
}

send_once() {
  local response rc
  # parse_mode is accepted by this wrapper for compatibility. openclaw message send
  # currently does not expose a parse_mode flag in this environment.
  response="$(openclaw message send --channel telegram --target "$CHAT_ID" --message "$MESSAGE_TEXT" --json 2>&1)"
  rc=$?

  # success = zero exit + non-empty response + no obvious hard-failure marker
  if [[ $rc -eq 0 ]] && [[ -n "${response//[[:space:]]/}" ]] && [[ "$response" != *'"ok":false'* ]] && [[ "$response" != *'"error"'* ]]; then
    return 0
  fi

  echo "$response"
  return 1
}

ensure_intent_id

TMP_OUT="$(mktemp /tmp/telegram-delivery-guard.XXXXXX)"
trap 'rm -f "$TMP_OUT" >/dev/null 2>&1 || true' EXIT

if send_once >"$TMP_OUT" 2>&1; then
  log_alert_delivery "delivered" 1 "delivered on first attempt"
  exit 0
fi

sleep 3

if send_once >"$TMP_OUT" 2>&1; then
  log_alert_delivery "delivered" 2 "delivered on retry"
  exit 0
fi

failure_detail="$(cat "$TMP_OUT" 2>/dev/null || echo "unknown error")"
log_alert_delivery "failed" 2 "$failure_detail"
log_delivery_failure "$failure_detail"
exit 1
