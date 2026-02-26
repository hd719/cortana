#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="cortana"
SOURCE="task-board-stale-detector"

usage() {
  cat <<'EOF'
Detect stale/orphaned tasks and auto-clean them up.

Usage:
  stale-detector.sh [run]

Behavior:
  1) Finds pending tasks older than 7 days with no activity and sets:
     metadata.stale_flagged=true
     metadata.stale_flagged_at=<timestamp>
  2) Finds in_progress tasks older than 2 hours with no matching active sub-agent
     and resets them to pending with metadata.orphan_reset details.
  3) Logs all actions to cortana_events.
  4) Prints a JSON report of all actions taken.
EOF
}

require_psql() {
  if [[ ! -x "$PSQL_BIN" ]]; then
    echo '{"status":"error","error":"psql binary not found","path":"'"$PSQL_BIN"'"}'
    exit 1
  fi
}

run_psql_json() {
  local sql="$1"
  shift
  "$PSQL_BIN" "$DB_NAME" -X -v ON_ERROR_STOP=1 -q -t -A "$@" <<SQL
${sql}
SQL
}

cmd_run() {
  local sql
  read -r -d '' sql <<'SQL' || true
WITH active_labels AS (
  SELECT DISTINCT e.payload->>'label' AS label
  FROM cortana_event_bus_events e
  WHERE e.event_type = 'agent_spawned'
    AND COALESCE(e.payload->>'label', '') <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM cortana_event_bus_events t
      WHERE t.created_at >= e.created_at
        AND t.event_type IN ('agent_completed', 'agent_failed', 'agent_timeout')
        AND t.payload->>'label' = e.payload->>'label'
    )
), stale_pending_candidates AS (
  SELECT
    t.id,
    t.title,
    COALESCE(t.updated_at, t.created_at) AS last_activity_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(t.updated_at, t.created_at)))::bigint AS age_seconds
  FROM cortana_tasks t
  WHERE t.status = 'pending'
    AND COALESCE(t.updated_at, t.created_at) < NOW() - INTERVAL '7 days'
    AND COALESCE((t.metadata->>'stale_flagged')::boolean, false) = false
  FOR UPDATE
), stale_pending_updated AS (
  UPDATE cortana_tasks t
  SET metadata = COALESCE(t.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'stale_flagged', true,
        'stale_flagged_at', NOW(),
        'stale_flag_reason', 'pending_no_activity_7d'
      ),
      updated_at = CURRENT_TIMESTAMP
  WHERE t.id IN (SELECT id FROM stale_pending_candidates)
  RETURNING
    t.id,
    t.title,
    COALESCE(t.updated_at, t.created_at) AS updated_at,
    t.metadata
), orphaned_in_progress_candidates AS (
  SELECT
    t.id,
    t.title,
    t.assigned_to,
    COALESCE(t.updated_at, t.created_at) AS last_activity_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(t.updated_at, t.created_at)))::bigint AS age_seconds
  FROM cortana_tasks t
  WHERE t.status = 'in_progress'
    AND COALESCE(t.updated_at, t.created_at) < NOW() - INTERVAL '2 hours'
    AND (
      t.assigned_to IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM active_labels a WHERE a.label = t.assigned_to
      )
    )
  FOR UPDATE
), orphaned_in_progress_updated AS (
  UPDATE cortana_tasks t
  SET status = 'pending',
      metadata = COALESCE(t.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'orphan_reset', jsonb_build_object(
            'at', NOW(),
            'reason', 'in_progress_no_active_subagent_2h',
            'previous_assigned_to', t.assigned_to,
            'note', 'Auto-reset by stale-detector: orphaned in_progress task moved back to pending'
          )
        ),
      updated_at = CURRENT_TIMESTAMP
  WHERE t.id IN (SELECT id FROM orphaned_in_progress_candidates)
  RETURNING
    t.id,
    t.title,
    t.assigned_to,
    t.status,
    t.updated_at,
    t.metadata
), stale_events AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    'task_stale_flagged',
    :'source',
    'warning',
    format('Flagged stale pending task %s', s.id::text),
    jsonb_build_object(
      'operation', 'stale-detect',
      'action', 'flag_stale_pending',
      'task_id', s.id,
      'title', s.title,
      'threshold', '7d',
      'stale_flagged_at', NOW()
    )
  FROM stale_pending_updated s
  RETURNING id, metadata->>'task_id' AS task_id
), orphan_events AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  SELECT
    'task_orphan_auto_reset',
    :'source',
    'warning',
    format('Reset orphaned in_progress task %s to pending', o.id::text),
    jsonb_build_object(
      'operation', 'stale-detect',
      'action', 'reset_orphaned_in_progress',
      'task_id', o.id,
      'title', o.title,
      'threshold', '2h',
      'assigned_to', o.assigned_to,
      'reset_at', NOW()
    )
  FROM orphaned_in_progress_updated o
  RETURNING id, metadata->>'task_id' AS task_id
), summary_event AS (
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  VALUES (
    'task_stale_detector_run',
    :'source',
    CASE
      WHEN (SELECT COUNT(*) FROM stale_pending_updated) + (SELECT COUNT(*) FROM orphaned_in_progress_updated) > 0 THEN 'warning'
      ELSE 'info'
    END,
    format(
      'stale-detector run complete: flagged=%s reset=%s',
      (SELECT COUNT(*) FROM stale_pending_updated),
      (SELECT COUNT(*) FROM orphaned_in_progress_updated)
    ),
    jsonb_build_object(
      'operation', 'stale-detect',
      'stale_pending_flagged_count', (SELECT COUNT(*) FROM stale_pending_updated),
      'orphaned_in_progress_reset_count', (SELECT COUNT(*) FROM orphaned_in_progress_updated),
      'active_labels', COALESCE((SELECT jsonb_agg(label) FROM active_labels), '[]'::jsonb),
      'stale_task_ids', COALESCE((SELECT jsonb_agg(id) FROM stale_pending_updated), '[]'::jsonb),
      'orphan_reset_task_ids', COALESCE((SELECT jsonb_agg(id) FROM orphaned_in_progress_updated), '[]'::jsonb)
    )
  )
  RETURNING id
)
SELECT json_build_object(
  'operation', 'stale-detect',
  'ok', true,
  'thresholds', json_build_object(
    'pending_no_activity', '7 days',
    'in_progress_no_active_subagent', '2 hours'
  ),
  'actions', json_build_object(
    'stale_pending_flagged_count', (SELECT COUNT(*) FROM stale_pending_updated),
    'orphaned_in_progress_reset_count', (SELECT COUNT(*) FROM orphaned_in_progress_updated),
    'stale_pending_flagged', COALESCE((SELECT json_agg(stale_pending_updated) FROM stale_pending_updated), '[]'::json),
    'orphaned_in_progress_reset', COALESCE((SELECT json_agg(orphaned_in_progress_updated) FROM orphaned_in_progress_updated), '[]'::json)
  ),
  'event_ids', json_build_object(
    'per_task_stale_flag_events', COALESCE((SELECT json_agg(id) FROM stale_events), '[]'::json),
    'per_task_orphan_reset_events', COALESCE((SELECT json_agg(id) FROM orphan_events), '[]'::json),
    'summary_event', (SELECT id FROM summary_event LIMIT 1)
  ),
  'timestamp', NOW()
)::text;
SQL

  run_psql_json "$sql" -v "source=$SOURCE"
}

main() {
  require_psql

  local cmd="${1:-run}"
  case "$cmd" in
    run)
      cmd_run
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "{\"status\":\"error\",\"error\":\"unknown_command\",\"command\":\"$cmd\"}"
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
