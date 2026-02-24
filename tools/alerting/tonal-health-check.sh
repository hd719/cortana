#!/usr/bin/env bash
set -euo pipefail

# Tonal health check with bounded network calls, deterministic assignee,
# and periodic progress checkpoints to avoid silent long-running timeouts.

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
TONAL_ENDPOINT="${TONAL_ENDPOINT:-http://localhost:8080/tonal/health}"
TONAL_FALLBACK_ENDPOINT="${TONAL_FALLBACK_ENDPOINT:-http://localhost:3033/tonal/health}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
CONNECT_TIMEOUT_SECONDS="${CONNECT_TIMEOUT_SECONDS:-3}"
READ_TIMEOUT_SECONDS="${READ_TIMEOUT_SECONDS:-8}"
RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-2}"
CHECKPOINT_SECONDS="${CHECKPOINT_SECONDS:-300}"

ASSIGNEE="${OPENCLAW_ASSIGNEE:-${ASSIGNED_TO:-${USER:-unknown}}@$(hostname -s 2>/dev/null || echo host)}"
RUN_ID="tonal-health-check-$(date +%s)-$$"
START_TS="$(date -Iseconds)"

log_event() {
  local sev="$1" msg="$2" meta="${3:-{}}"
  local esc_msg esc_meta
  esc_msg=$(echo "$msg" | sed "s/'/''/g")
  esc_meta=$(echo "$meta" | sed "s/'/''/g")
  psql "$DB" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('tonal_health_check', 'tonal-health-check', '${sev}', '${esc_msg}', '${esc_meta}');" >/dev/null 2>&1 || true
}

emit() {
  local level="$1" message="$2"
  local now
  now="$(date -Iseconds)"
  echo "[$now] [$RUN_ID] [$ASSIGNEE] [$level] $message"
}

checkpoint_loop() {
  while true; do
    sleep "$CHECKPOINT_SECONDS"
    emit "checkpoint" "still running; assignee=${ASSIGNEE}; elapsed=${SECONDS}s"
    log_event "info" "Tonal health check progress checkpoint" "{\"run_id\":\"${RUN_ID}\",\"assignee\":\"${ASSIGNEE}\",\"elapsed_seconds\":${SECONDS}}"
  done
}

check_once() {
  local endpoint="$1"
  curl -sS --fail \
    --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
    --max-time "$READ_TIMEOUT_SECONDS" \
    "$endpoint"
}

emit "start" "run started; assignee=${ASSIGNEE}; endpoint=${TONAL_ENDPOINT}; max_attempts=${MAX_ATTEMPTS}"
log_event "info" "Tonal health check started" "{\"run_id\":\"${RUN_ID}\",\"assignee\":\"${ASSIGNEE}\",\"endpoint\":\"${TONAL_ENDPOINT}\",\"max_attempts\":${MAX_ATTEMPTS},\"start\":\"${START_TS}\"}"

checkpoint_loop &
CHECKPOINT_PID=$!
trap 'kill "$CHECKPOINT_PID" >/dev/null 2>&1 || true' EXIT

attempt=1
last_error=""
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  emit "progress" "attempt ${attempt}/${MAX_ATTEMPTS} against primary endpoint"
  if response="$(check_once "$TONAL_ENDPOINT" 2>&1)"; then
    emit "ok" "primary endpoint healthy"
    log_event "info" "Tonal health check succeeded" "{\"run_id\":\"${RUN_ID}\",\"assignee\":\"${ASSIGNEE}\",\"attempt\":${attempt},\"endpoint\":\"${TONAL_ENDPOINT}\"}"
    echo "$response"
    exit 0
  fi

  last_error="$response"
  emit "warn" "primary endpoint failed (attempt ${attempt}): ${last_error}"

  emit "progress" "attempt ${attempt}/${MAX_ATTEMPTS} against fallback endpoint"
  if response="$(check_once "$TONAL_FALLBACK_ENDPOINT" 2>&1)"; then
    emit "ok" "fallback endpoint healthy"
    log_event "warning" "Tonal health check succeeded via fallback" "{\"run_id\":\"${RUN_ID}\",\"assignee\":\"${ASSIGNEE}\",\"attempt\":${attempt},\"endpoint\":\"${TONAL_FALLBACK_ENDPOINT}\"}"
    echo "$response"
    exit 0
  fi

  last_error="$response"
  emit "warn" "fallback endpoint failed (attempt ${attempt}): ${last_error}"

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$RETRY_SLEEP_SECONDS"
  fi

  attempt=$((attempt + 1))
done

emit "error" "all attempts failed; assignee=${ASSIGNEE}; last_error=${last_error}"
log_event "error" "Tonal health check failed" "{\"run_id\":\"${RUN_ID}\",\"assignee\":\"${ASSIGNEE}\",\"endpoint\":\"${TONAL_ENDPOINT}\",\"fallback_endpoint\":\"${TONAL_FALLBACK_ENDPOINT}\",\"max_attempts\":${MAX_ATTEMPTS},\"last_error\":\"${last_error//\"/\\\"}\"}"
exit 1
