#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB_NAME="${CORTANA_DB:-cortana}"

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

# Usage:
#   emit_run_event <run_id> <task_id_or_empty> <event_type> <source_or_empty> <metadata_json_or_empty>
emit_run_event() {
  local run_id="${1:-}"
  local task_id="${2:-}"
  local event_type="${3:-}"
  local source="${4:-}"
  local metadata="${5:-}"

  if [[ -z "$run_id" || -z "$event_type" ]]; then
    return 1
  fi

  local run_id_esc source_esc event_type_esc metadata_esc
  run_id_esc="$(sql_escape "$run_id")"
  source_esc="$(sql_escape "$source")"
  event_type_esc="$(sql_escape "$event_type")"

  if [[ -z "$metadata" ]]; then
    metadata='{}'
  fi
  metadata_esc="$(sql_escape "$metadata")"

  local task_expr="NULL"
  if [[ -n "$task_id" ]]; then
    task_expr="$task_id"
  fi

  "$PSQL_BIN" "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -c "
    INSERT INTO cortana_run_events (run_id, task_id, event_type, source, metadata)
    VALUES (
      '${run_id_esc}',
      ${task_expr},
      '${event_type_esc}',
      NULLIF('${source_esc}',''),
      '${metadata_esc}'::jsonb
    );
  " >/dev/null
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  emit_run_event "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}"
fi
