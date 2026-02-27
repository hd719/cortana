#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB_NAME="${DB_NAME:-cortana}"
SOURCE="meta-monitor"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${SCRIPT_DIR}/state"
STATE_FILE="${STATE_DIR}/meta-monitor-consecutive.state"
mkdir -p "$STATE_DIR"

run_quarantine_tracker() {
  local tracker_script
  tracker_script="${SCRIPT_DIR}/quarantine-tracker.sh"
  if [[ -x "$tracker_script" ]]; then
    "$tracker_script" >/dev/null 2>&1 || true
  fi
}

# monitor_name|sql_filter|sla_seconds|human_sla
MONITORS=(
  "watchdog|event_type ILIKE '%watchdog%'|1200|15m"
  "proprioception|event_type ILIKE '%proprioception%' OR event_type ILIKE '%health_check%'|9000|2h"
  "cron_preflight|event_type = 'cron_preflight'|93600|24h"
  "subagent_watchdog|event_type ILIKE '%subagent%watchdog%'|1800|heartbeat"
  "heartbeat_state_validation|event_type = 'heartbeat_state_snapshot'|23400|6h"
)

if [[ ! -x "$PSQL_BIN" ]]; then
  echo "psql not executable at $PSQL_BIN" >&2
  exit 1
fi

run_quarantine_tracker

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

query_last_seen_epoch() {
  local where_clause="$1"
  "$PSQL_BIN" "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "
    SELECT COALESCE(EXTRACT(EPOCH FROM MAX(timestamp))::bigint, 0)
    FROM cortana_events
    WHERE (${where_clause});
  " 2>/dev/null | tr -d '[:space:]'
}

query_last_seen_iso() {
  local where_clause="$1"
  "$PSQL_BIN" "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "
    SELECT COALESCE(to_char(MAX(timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'unknown')
    FROM cortana_events
    WHERE (${where_clause});
  " 2>/dev/null | tr -d '[:space:]'
}

insert_overdue_event() {
  local severity="$1" monitor="$2" last_seen="$3" age_seconds="$4" sla_seconds="$5" sla_human="$6" consecutive="$7"
  local esc_monitor esc_last_seen esc_message esc_sla_human
  esc_monitor="$(sql_escape "$monitor")"
  esc_last_seen="$(sql_escape "$last_seen")"
  esc_sla_human="$(sql_escape "$sla_human")"
  esc_message="$(sql_escape "Meta-monitor overdue: $monitor (age=${age_seconds}s, sla=${sla_seconds}s, consecutive=${consecutive})")"

  "$PSQL_BIN" "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -c "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'meta_monitor_alert',
      '$SOURCE',
      '$severity',
      '$esc_message',
      jsonb_build_object(
        'monitor', '$esc_monitor',
        'last_seen', '$esc_last_seen',
        'age_seconds', $age_seconds,
        'sla_seconds', $sla_seconds,
        'sla', '$esc_sla_human',
        'consecutive_overdue', $consecutive
      )
    );
  " >/dev/null 2>&1 || true
}

insert_healthy_event() {
  local healthy_csv="$1" now_epoch="$2"
  local esc_healthy esc_message
  esc_healthy="$(sql_escape "$healthy_csv")"
  esc_message="$(sql_escape "Meta-monitor healthy: all monitor SLAs satisfied")"

  "$PSQL_BIN" "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -c "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'meta_monitor_alert',
      '$SOURCE',
      'info',
      '$esc_message',
      jsonb_build_object('monitors', '$esc_healthy', 'checked_at_epoch', $now_epoch)
    );
  " >/dev/null 2>&1 || true
}

STATE_TMP="$(mktemp)"
trap 'rm -f "$STATE_TMP" "$STATE_TMP.new"' EXIT
if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$STATE_TMP"
else
  : > "$STATE_TMP"
fi

state_get() {
  local key="$1"
  local out
  out="$(awk -F= -v k="$key" '$1==k {print $2; found=1; exit} END {if (!found) print 0}' "$STATE_TMP")"
  [[ "$out" =~ ^[0-9]+$ ]] || out=0
  echo "$out"
}

state_set() {
  local key="$1"
  local val="$2"
  awk -F= -v k="$key" -v v="$val" '
    BEGIN {updated=0}
    $1==k {print k "=" v; updated=1; next}
    {print}
    END {if (!updated) print k "=" v}
  ' "$STATE_TMP" > "$STATE_TMP.new"
  mv "$STATE_TMP.new" "$STATE_TMP"
}

now_epoch="$(date +%s)"
overdue_count=0

for row in "${MONITORS[@]}"; do
  IFS='|' read -r monitor where_clause sla_seconds sla_human <<< "$row"

  last_seen_epoch="$(query_last_seen_epoch "$where_clause")"
  [[ "$last_seen_epoch" =~ ^[0-9]+$ ]] || last_seen_epoch=0

  if [[ "$last_seen_epoch" -eq 0 ]]; then
    age_seconds=999999999
    last_seen_iso="unknown"
  else
    age_seconds=$((now_epoch - last_seen_epoch))
    last_seen_iso="$(query_last_seen_iso "$where_clause")"
  fi

  if (( age_seconds > sla_seconds )); then
    prev="$(state_get "$monitor")"
    curr=$((prev + 1))
    state_set "$monitor" "$curr"
    overdue_count=$((overdue_count + 1))

    severity="warning"
    if (( curr >= 2 )); then
      severity="critical"
    fi

    insert_overdue_event "$severity" "$monitor" "$last_seen_iso" "$age_seconds" "$sla_seconds" "$sla_human" "$curr"
  else
    state_set "$monitor" "0"
  fi
done

if (( overdue_count == 0 )); then
  healthy_list="$(printf '%s\n' "${MONITORS[@]}" | cut -d'|' -f1 | paste -sd ',' -)"
  insert_healthy_event "$healthy_list" "$now_epoch"
fi

cp "$STATE_TMP" "$STATE_FILE"

echo "meta-monitor complete: overdue=$overdue_count"
