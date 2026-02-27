#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB_NAME="${DB_NAME:-cortana}"
SOURCE="quarantine-tracker"
QDIR="${HOME}/.openclaw/cron/quarantine"

if [[ ! -x "$PSQL_BIN" ]]; then
  echo "psql not executable at $PSQL_BIN" >&2
  exit 1
fi

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

run_sql() {
  "$PSQL_BIN" "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null
}

insert_event() {
  local severity="$1" message="$2" metadata_json="$3"
  local esc_message esc_meta
  esc_message="$(sql_escape "$message")"
  esc_meta="$(sql_escape "$metadata_json")"
  run_sql "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES ('quarantine_status', '$SOURCE', '$severity', '$esc_message', '$esc_meta'::jsonb);
  " >/dev/null || true
}

find_open_task_id() {
  local title="$1"
  local esc_title
  esc_title="$(sql_escape "$title")"
  run_sql "
    SELECT id
    FROM cortana_tasks
    WHERE title = '$esc_title'
      AND status IN ('ready','in_progress','blocked')
    ORDER BY created_at DESC
    LIMIT 1;
  " | tr -d '[:space:]'
}

create_task() {
  local title="$1" description="$2" metadata_json="$3"
  local esc_title esc_desc esc_meta
  esc_title="$(sql_escape "$title")"
  esc_desc="$(sql_escape "$description")"
  esc_meta="$(sql_escape "$metadata_json")"
  run_sql "
    INSERT INTO cortana_tasks (
      source, title, description, priority, status, assigned_to, metadata
    ) VALUES (
      '$SOURCE', '$esc_title', '$esc_desc', 2, 'ready', 'monitor', '$esc_meta'::jsonb
    );
  " >/dev/null || true
}

escalate_task_priority() {
  local task_id="$1"
  run_sql "
    UPDATE cortana_tasks
    SET priority = 1,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'escalated_by', '$SOURCE',
          'escalated_at', NOW()
        )
    WHERE id = $task_id
      AND priority > 1;
  " >/dev/null || true
}

mkdir -p "$QDIR"
now_epoch="$(date +%s)"
total_quarantined=0
longest_duration=0
longest_job=""
new_tasks=0
escalated_tasks=0

shopt -s nullglob
for qfile in "$QDIR"/*.quarantined; do
  [[ -f "$qfile" ]] || continue

  total_quarantined=$((total_quarantined + 1))
  base="$(basename "$qfile")"
  job_name="${base%.quarantined}"

  mtime_epoch="$(stat -f %m "$qfile" 2>/dev/null || echo "$now_epoch")"
  [[ "$mtime_epoch" =~ ^[0-9]+$ ]] || mtime_epoch="$now_epoch"

  duration_seconds=$((now_epoch - mtime_epoch))
  (( duration_seconds < 0 )) && duration_seconds=0
  duration_hours=$((duration_seconds / 3600))

  if (( duration_seconds > longest_duration )); then
    longest_duration="$duration_seconds"
    longest_job="$job_name"
  fi

  title="Investigate quarantined cron: $job_name"
  open_task_id="$(find_open_task_id "$title")"

  created_task_for_job=0
  escalated_task_for_job=0

  if (( duration_seconds > 86400 )) && [[ -z "$open_task_id" ]]; then
    create_task "$title" "Cron '$job_name' has been quarantined for ${duration_hours}h. Investigate failing preflight dependency and release quarantine safely." "{\"job\":\"$job_name\",\"quarantine_file\":\"$qfile\",\"duration_seconds\":$duration_seconds,\"trigger\":\">24h_quarantine\"}"
    open_task_id="$(find_open_task_id "$title")"
    if [[ -n "$open_task_id" ]]; then
      new_tasks=$((new_tasks + 1))
      created_task_for_job=1
    fi
  fi

  if (( duration_seconds > 172800 )) && [[ -n "$open_task_id" ]]; then
    before_priority="$(run_sql "SELECT priority FROM cortana_tasks WHERE id = $open_task_id;" | tr -d '[:space:]')"
    escalate_task_priority "$open_task_id"
    after_priority="$(run_sql "SELECT priority FROM cortana_tasks WHERE id = $open_task_id;" | tr -d '[:space:]')"
    if [[ "$before_priority" != "1" && "$after_priority" == "1" ]]; then
      escalated_tasks=$((escalated_tasks + 1))
      escalated_task_for_job=1
    fi
  fi

  q_count_24h="$(run_sql "SELECT COUNT(*) FROM cortana_events WHERE event_type='quarantine_status' AND metadata->>'job'='$(sql_escape "$job_name")' AND timestamp >= NOW() - INTERVAL '24 hours';" | tr -d '[:space:]')"
  q_count_7d="$(run_sql "SELECT COUNT(*) FROM cortana_events WHERE event_type='quarantine_status' AND metadata->>'job'='$(sql_escape "$job_name")' AND timestamp >= NOW() - INTERVAL '7 days';" | tr -d '[:space:]')"
  [[ "$q_count_24h" =~ ^[0-9]+$ ]] || q_count_24h=0
  [[ "$q_count_7d" =~ ^[0-9]+$ ]] || q_count_7d=0

  severity="info"
  if (( duration_seconds > 172800 )); then
    severity="critical"
  elif (( duration_seconds > 86400 )); then
    severity="warning"
  fi

  insert_event "$severity" \
    "Quarantine active: $job_name (${duration_hours}h)" \
    "{\"job\":\"$job_name\",\"quarantine_file\":\"$qfile\",\"duration_seconds\":$duration_seconds,\"duration_hours\":$duration_hours,\"quarantine_count_24h\":$q_count_24h,\"quarantine_count_7d\":$q_count_7d,\"task_created\":$created_task_for_job,\"task_escalated\":$escalated_task_for_job}"
done
shopt -u nullglob

if (( total_quarantined == 0 )); then
  insert_event "info" "No active quarantined cron jobs" "{\"total_quarantined\":0}"
fi

longest_hours=$((longest_duration / 3600))
if (( total_quarantined > 0 )); then
  echo "quarantine-tracker: total_quarantined=$total_quarantined longest_job=$longest_job longest_duration_hours=$longest_hours new_tasks=$new_tasks escalated_tasks=$escalated_tasks"
else
  echo "quarantine-tracker: total_quarantined=0 longest_duration_hours=0 new_tasks=0 escalated_tasks=0"
fi
