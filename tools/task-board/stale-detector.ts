#!/usr/bin/env npx tsx

import fs from "fs";
import { spawnSync } from "child_process";
import { withPostgresPath } from "../lib/db.js";

const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB_NAME = "cortana";
const SOURCE = "task-board-stale-detector";

function usage(): void {
  process.stdout.write(`Detect stale/orphaned tasks and auto-clean them up.\n\nUsage:\n  stale-detector.sh [run]\n\nBehavior:\n  1) Finds pending tasks older than 7 days with no activity and sets:\n     metadata.stale_flagged=true\n     metadata.stale_flagged_at=<timestamp>\n  2) Finds in_progress tasks older than 2 hours with no matching active sub-agent\n     and resets them to pending with metadata.orphan_reset details.\n  3) Logs all actions to cortana_events.\n  4) Prints a JSON report of all actions taken.\n`);
}

function requirePsql(): void {
  try {
    fs.accessSync(PSQL_BIN, fs.constants.X_OK);
  } catch {
    console.log(JSON.stringify({ status: "error", error: "psql binary not found", path: PSQL_BIN }));
    process.exit(1);
  }
}

function runPsqlJson(sql: string): string {
  const result = spawnSync(
    PSQL_BIN,
    [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-v", `source=${SOURCE}`],
    {
      input: `${sql}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
      env: withPostgresPath(process.env),
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout || "";
}

function cmdRun(): void {
  const sql = String.raw`WITH active_agents AS (
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
), stale_pending_candidates AS (
  SELECT
    t.id,
    t.title,
    COALESCE(t.updated_at, t.created_at) AS last_activity_at,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(t.updated_at, t.created_at)))::bigint AS age_seconds
  FROM cortana_tasks t
  WHERE t.status = 'ready'
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
      (t.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM active_agents a WHERE a.run_id = t.run_id
      ))
      OR (
        t.run_id IS NULL
        AND (
          t.assigned_to IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM active_agents a WHERE a.label = t.assigned_to
          )
        )
      )
    )
  FOR UPDATE
), orphaned_in_progress_updated AS (
  UPDATE cortana_tasks t
  SET status = 'ready',
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
      'active_agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('run_id', run_id, 'label', label)) FROM active_agents), '[]'::jsonb),
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
)::text;`;

  process.stdout.write(runPsqlJson(sql));
}

function main(): void {
  requirePsql();

  const cmd = process.argv[2] || "run";
  switch (cmd) {
    case "run":
      cmdRun();
      break;
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      console.log(JSON.stringify({ status: "error", error: "unknown_command", command: cmd }));
      process.stderr.write(`Detect stale/orphaned tasks and auto-clean them up.\n\nUsage:\n  stale-detector.sh [run]\n\nBehavior:\n  1) Finds pending tasks older than 7 days with no activity and sets:\n     metadata.stale_flagged=true\n     metadata.stale_flagged_at=<timestamp>\n  2) Finds in_progress tasks older than 2 hours with no matching active sub-agent\n     and resets them to pending with metadata.orphan_reset details.\n  3) Logs all actions to cortana_events.\n  4) Prints a JSON report of all actions taken.\n`);
      process.exit(1);
  }
}

main();
