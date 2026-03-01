#!/usr/bin/env bash
set -u

SERVICE_PORT="3033"
SERVICE_URL="http://127.0.0.1:3033/health"
BASE_DIR="$HOME/Developer/cortana-external"
TONAL_TOKENS="$BASE_DIR/tonal_tokens.json"

parse_epoch() {
  local raw="$1"
  local norm
  norm=$(printf '%s' "$raw" | sed -E 's/\.[0-9]+//' | sed -E 's/([+-][0-9]{2}):([0-9]{2})$/\1\2/')

  if date -u -d "$norm" +%s >/dev/null 2>&1; then
    date -u -d "$norm" +%s
    return 0
  fi

  if [[ "$norm" == *"Z" ]]; then
    date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$norm" +%s 2>/dev/null && return 0
  fi

  date -j -u -f "%Y-%m-%dT%H:%M:%S%z" "$norm" +%s 2>/dev/null
}

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

restart_service() {
  log "Service appears down. Restarting cortana-external..."
  (
    cd "$BASE_DIR" || exit 1
    set -a
    source ./.env
    set +a
    nohup go run main.go >/tmp/cortana-external.log 2>&1 &
  )

  for _ in {1..30}; do
    if is_port_open; then
      log "Recovery success: service listening on port $SERVICE_PORT"
      return 0
    fi
    sleep 1
  done

  log "Recovery warning: service restart attempted but still not listening"
  return 1
}

is_port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$SERVICE_PORT" >/dev/null 2>&1
    return $?
  fi
  (echo > /dev/tcp/127.0.0.1/"$SERVICE_PORT") >/dev/null 2>&1
}

is_service_up=0
if is_port_open; then
  code=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" "$SERVICE_URL" 2>/dev/null || echo "000")
  if [[ "$code" == "200" || "$code" == "503" ]]; then
    is_service_up=1
    log "Service check: up (port open, /health status $code)"
  fi
fi

if [[ "$is_service_up" -eq 0 ]]; then
  restart_service || true
fi

# Tonal token recovery: delete token file if missing/expired/unparsable to trigger re-auth.
if [[ ! -f "$TONAL_TOKENS" ]]; then
  log "Tonal token missing: $TONAL_TOKENS (nothing to delete; re-auth will occur on next request)"
else
  tonal_exp=$(jq -r '.expires_at // empty' "$TONAL_TOKENS" 2>/dev/null)
  tonal_id=$(jq -r '.id_token // empty' "$TONAL_TOKENS" 2>/dev/null)
  now_epoch=$(date +%s)

  needs_reset=0
  reason=""

  if [[ -z "$tonal_id" || -z "$tonal_exp" ]]; then
    needs_reset=1
    reason="missing id_token/expires_at"
  else
    tonal_exp_epoch=$(parse_epoch "$tonal_exp" 2>/dev/null || echo "")
    if [[ -z "$tonal_exp_epoch" ]]; then
      needs_reset=1
      reason="unparsable expires_at=$tonal_exp"
    elif [[ "$tonal_exp_epoch" -le "$now_epoch" ]]; then
      needs_reset=1
      reason="expired at $tonal_exp"
    fi
  fi

  if [[ "$needs_reset" -eq 1 ]]; then
    rm -f "$TONAL_TOKENS"
    log "Deleted tonal_tokens.json to trigger re-auth ($reason)"
  else
    log "Tonal token valid; no reset needed"
  fi
fi

log "Auto-recovery run complete"
exit 0
