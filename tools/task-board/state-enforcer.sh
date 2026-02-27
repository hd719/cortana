#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="cortana"
SOURCE="task-board-state-enforcer"

usage() {
  cat <<'EOF'
Enforce atomic cortana_tasks state transitions.

Usage:
  state-enforcer.sh spawn-start <task_id> <assigned_to>
  state-enforcer.sh complete <task_id> <outcome>
  state-enforcer.sh fail <task_id> <reason>
  state-enforcer.sh check-orphans
  state-enforcer.sh reset-stale

Notes:
  - All commands print JSON to stdout.
  - Transition commands are atomic and append to cortana_events.
EOF
}

require_psql() {
  if [[ ! -x "$PSQL_BIN" ]]; then
    echo '{"status":"error","error":"psql binary not found","path":"'"$PSQL_BIN"'"}'
    exit 1
  fi
}

is_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

json_escape() {
  local s="${1:-}"
  s=${s//\\/\\\\}
  s=${s//"/\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

run_psql_json() {
  local sql="$1"
  shift
  "$PSQL_BIN" "$DB_NAME" -X -v ON_ERROR_STOP=1 -q -t -A "$@" <<SQL
${sql}
SQL
}

cmd_spawn_start() {
  local task_id="$1"
  local assigned_to="$2"

  local sql
  read -r -d '' sql <<'SQL' || true
WITH locked AS (
  SELECT id, status, title, assigned_to
  FROM cortana_tasks
  WHERE id = :task_id
  FOR UPDATE
), updated AS (
  UPDATE cortana_tasks t
  SET status='in_progress',
      assigned_to = :'assigned_to',
      updated_at = CURRENT_TIMESTAMP
  FROM locked l
  WHERE t.id = l.id
    AND l.status = 'ready'
  RETURNING t.id, t.status, t.assigned_to, t.title, t.updated_at
), event_insert AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'task_state_transition' ELSE 'task_state_transition_rejected' END,
    :'source',
    CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'info' ELSE 'warning' END,
    CASE WHEN EXISTS (SELECT 1 FROM updated)
      THEN format('Task %s moved ready -> in_progress', :task_id::text)
      ELSE format('Rejected spawn-start for task %s', :task_id::text)
    END,
    jsonb_build_object(
      'operation', 'spawn-start',
      'task_id', :task_id::int,
      'requested_assigned_to', :'assigned_to',
      'previous_status', (SELECT status FROM locked LIMIT 1),
      'result_status', (SELECT status FROM updated LIMIT 1),
      'ok', EXISTS (SELECT 1 FROM updated)
    )
  RETURNING id
)
SELECT json_build_object(
  'operation', 'spawn-start',
  'ok', EXISTS (SELECT 1 FROM updated),
  'task_id', :task_id::int,
  'assigned_to', :'assigned_to',
  'error', CASE
    WHEN NOT EXISTS (SELECT 1 FROM locked) THEN 'task_not_found'
    WHEN NOT EXISTS (SELECT 1 FROM updated) THEN format('invalid_state:%s', (SELECT status FROM locked LIMIT 1))
    ELSE NULL
  END,
  'task', (SELECT row_to_json(updated) FROM updated LIMIT 1),
  'event_id', (SELECT id FROM event_insert LIMIT 1),
  'timestamp', NOW()
)::text;
SQL

  run_psql_json "$sql" \
    -v "source=$SOURCE" \
    -v "task_id=$task_id" \
    -v "assigned_to=$assigned_to"
}

cmd_complete() {
  local task_id="$1"
  local outcome="$2"

  local sql
  read -r -d '' sql <<'SQL' || true
WITH locked AS (
  SELECT id, status, title
  FROM cortana_tasks
  WHERE id = :task_id
  FOR UPDATE
), updated AS (
  UPDATE cortana_tasks t
  SET status='completed',
      completed_at = NOW(),
      outcome = :'outcome',
      updated_at = CURRENT_TIMESTAMP
  FROM locked l
  WHERE t.id = l.id
    AND l.status = 'in_progress'
  RETURNING t.id, t.status, t.title, t.completed_at, t.outcome, t.updated_at
), event_insert AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'task_state_transition' ELSE 'task_state_transition_rejected' END,
    :'source',
    CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'info' ELSE 'warning' END,
    CASE WHEN EXISTS (SELECT 1 FROM updated)
      THEN format('Task %s moved in_progress -> completed', :task_id::text)
      ELSE format('Rejected complete for task %s', :task_id::text)
    END,
    jsonb_build_object(
      'operation', 'complete',
      'task_id', :task_id::int,
      'outcome', :'outcome',
      'previous_status', (SELECT status FROM locked LIMIT 1),
      'result_status', (SELECT status FROM updated LIMIT 1),
      'ok', EXISTS (SELECT 1 FROM updated)
    )
  RETURNING id
)
SELECT json_build_object(
  'operation', 'complete',
  'ok', EXISTS (SELECT 1 FROM updated),
  'task_id', :task_id::int,
  'error', CASE
    WHEN NOT EXISTS (SELECT 1 FROM locked) THEN 'task_not_found'
    WHEN NOT EXISTS (SELECT 1 FROM updated) THEN format('invalid_state:%s', (SELECT status FROM locked LIMIT 1))
    ELSE NULL
  END,
  'task', (SELECT row_to_json(updated) FROM updated LIMIT 1),
  'event_id', (SELECT id FROM event_insert LIMIT 1),
  'timestamp', NOW()
)::text;
SQL

  run_psql_json "$sql" \
    -v "source=$SOURCE" \
    -v "task_id=$task_id" \
    -v "outcome=$outcome"
}

cmd_fail() {
  local task_id="$1"
  local reason="$2"

  local sql
  read -r -d '' sql <<'SQL' || true
WITH locked AS (
  SELECT id, status, title
  FROM cortana_tasks
  WHERE id = :task_id
  FOR UPDATE
), updated AS (
  UPDATE cortana_tasks t
  SET status='failed',
      outcome = :'reason',
      updated_at = CURRENT_TIMESTAMP
  FROM locked l
  WHERE t.id = l.id
    AND l.status = 'in_progress'
  RETURNING t.id, t.status, t.title, t.outcome, t.updated_at
), event_insert AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'task_state_transition' ELSE 'task_state_transition_rejected' END,
    :'source',
    CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 'warning' ELSE 'warning' END,
    CASE WHEN EXISTS (SELECT 1 FROM updated)
      THEN format('Task %s moved in_progress -> failed', :task_id::text)
      ELSE format('Rejected fail for task %s', :task_id::text)
    END,
    jsonb_build_object(
      'operation', 'fail',
      'task_id', :task_id::int,
      'reason', :'reason',
      'previous_status', (SELECT status FROM locked LIMIT 1),
      'result_status', (SELECT status FROM updated LIMIT 1),
      'ok', EXISTS (SELECT 1 FROM updated)
    )
  RETURNING id
)
SELECT json_build_object(
  'operation', 'fail',
  'ok', EXISTS (SELECT 1 FROM updated),
  'task_id', :task_id::int,
  'error', CASE
    WHEN NOT EXISTS (SELECT 1 FROM locked) THEN 'task_not_found'
    WHEN NOT EXISTS (SELECT 1 FROM updated) THEN format('invalid_state:%s', (SELECT status FROM locked LIMIT 1))
    ELSE NULL
  END,
  'task', (SELECT row_to_json(updated) FROM updated LIMIT 1),
  'event_id', (SELECT id FROM event_insert LIMIT 1),
  'timestamp', NOW()
)::text;
SQL

  run_psql_json "$sql" \
    -v "source=$SOURCE" \
    -v "task_id=$task_id" \
    -v "reason=$reason"
}

cmd_check_orphans() {
  local sql
  read -r -d '' sql <<'SQL' || true
WITH active_agents AS (
  SELECT DISTINCT
    NULLIF(e.payload->>'run_id', '') AS run_id,
    NULLIF(e.payload->>'label', '') AS label
  FROM cortana_event_bus_events e
  WHERE e.event_type = 'agent_spawned'
    AND (
      COALESCE(e.payload->>'label', '') <> ''
      OR COALESCE(e.payload->>'run_id', '') <> ''
    )
    AND NOT EXISTS (
      SELECT 1
      FROM cortana_event_bus_events t
      WHERE t.created_at >= e.created_at
        AND t.event_type IN ('agent_completed', 'agent_failed', 'agent_timeout')
        AND (
          (NULLIF(e.payload->>'run_id', '') IS NOT NULL AND t.payload->>'run_id' = e.payload->>'run_id')
          OR (
            NULLIF(e.payload->>'run_id', '') IS NULL
            AND NULLIF(e.payload->>'label', '') IS NOT NULL
            AND t.payload->>'label' = e.payload->>'label'
          )
        )
    )
), orphaned AS (
  SELECT
    t.id,
    t.title,
    t.assigned_to,
    t.status,
    t.updated_at,
    t.created_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(t.updated_at, t.created_at)))::bigint AS age_seconds
  FROM cortana_tasks t
  WHERE t.status = 'in_progress'
    AND COALESCE(t.updated_at, t.created_at) < NOW() - INTERVAL '2 hours'
    AND (
      (t.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM active_agents a WHERE a.run_id = t.run_id
      ))
      OR (
        t.run_id IS NULL
        AND (
          t.assigned_to IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM active_agents a
            WHERE a.label = t.assigned_to
          )
        )
      )
    )
  ORDER BY COALESCE(t.updated_at, t.created_at) ASC
), event_insert AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    'task_orphan_check',
    :'source',
    CASE WHEN (SELECT COUNT(*) FROM orphaned) > 0 THEN 'warning' ELSE 'info' END,
    format('check-orphans found %s orphaned tasks', (SELECT COUNT(*) FROM orphaned)),
    jsonb_build_object(
      'operation', 'check-orphans',
      'orphan_count', (SELECT COUNT(*) FROM orphaned),
      'active_agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('run_id', run_id, 'label', label)) FROM active_agents), '[]'::jsonb),
      'orphans', COALESCE((SELECT jsonb_agg(to_jsonb(orphaned)) FROM orphaned), '[]'::jsonb)
    )
  RETURNING id
)
SELECT json_build_object(
  'operation', 'check-orphans',
  'ok', true,
  'threshold', '2h',
  'active_agents', COALESCE((SELECT json_agg(json_build_object('run_id', run_id, 'label', label)) FROM active_agents), '[]'::json),
  'orphans', COALESCE((SELECT json_agg(orphaned) FROM orphaned), '[]'::json),
  'orphan_count', (SELECT COUNT(*) FROM orphaned),
  'event_id', (SELECT id FROM event_insert LIMIT 1),
  'timestamp', NOW()
)::text;
SQL

  run_psql_json "$sql" -v "source=$SOURCE"
}

cmd_reset_stale() {
  local sql
  read -r -d '' sql <<'SQL' || true
WITH stale AS (
  SELECT id
  FROM cortana_tasks
  WHERE status = 'ready'
    AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '7 days'
  FOR UPDATE
), updated AS (
  UPDATE cortana_tasks t
  SET status = 'ready',
      metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object(
        'stale_reset', jsonb_build_object(
          'at', NOW(),
          'note', 'reset-stale touched task after >7d pending'
        )
      ),
      updated_at = CURRENT_TIMESTAMP
  WHERE t.id IN (SELECT id FROM stale)
  RETURNING t.id, t.title, t.status, t.updated_at, t.metadata
), event_insert AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    'task_stale_reset',
    :'source',
    CASE WHEN (SELECT COUNT(*) FROM updated) > 0 THEN 'info' ELSE 'info' END,
    format('reset-stale touched %s pending tasks', (SELECT COUNT(*) FROM updated)),
    jsonb_build_object(
      'operation', 'reset-stale',
      'stale_count', (SELECT COUNT(*) FROM updated),
      'task_ids', COALESCE((SELECT jsonb_agg(id) FROM updated), '[]'::jsonb)
    )
  RETURNING id
)
SELECT json_build_object(
  'operation', 'reset-stale',
  'ok', true,
  'stale_threshold', '7d',
  'updated_count', (SELECT COUNT(*) FROM updated),
  'updated_tasks', COALESCE((SELECT json_agg(updated) FROM updated), '[]'::json),
  'event_id', (SELECT id FROM event_insert LIMIT 1),
  'timestamp', NOW()
)::text;
SQL

  run_psql_json "$sql" -v "source=$SOURCE"
}

main() {
  require_psql

  local cmd="${1:-}"
  case "$cmd" in
    spawn-start)
      local task_id="${2:-}" assigned_to="${3:-}"
      if ! is_int "$task_id" || [[ -z "$assigned_to" ]]; then
        usage
        exit 1
      fi
      cmd_spawn_start "$task_id" "$assigned_to"
      ;;
    complete)
      local task_id="${2:-}" outcome="${3:-}"
      if ! is_int "$task_id" || [[ -z "$outcome" ]]; then
        usage
        exit 1
      fi
      cmd_complete "$task_id" "$outcome"
      ;;
    fail)
      local task_id="${2:-}" reason="${3:-}"
      if ! is_int "$task_id" || [[ -z "$reason" ]]; then
        usage
        exit 1
      fi
      cmd_fail "$task_id" "$reason"
      ;;
    check-orphans)
      cmd_check_orphans
      ;;
    reset-stale)
      cmd_reset_stale
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      echo "{\"status\":\"error\",\"error\":\"unknown_command\",\"command\":\"$(json_escape "$cmd")\"}"
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
