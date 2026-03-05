#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import db from "../lib/db.js";
const { withPostgresPath } = db;
import { PSQL_BIN } from "../lib/paths.js";

const SQL = `WITH candidates AS (
  SELECT
    f.id,
    f.severity,
    f.summary,
    f.details,
    f.recurrence_key,
    COALESCE((SELECT COUNT(*) FROM mc_feedback_items m WHERE m.recurrence_key IS NOT NULL AND m.recurrence_key = f.recurrence_key), 0) AS recurrence_count,
    EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = f.id::text
    ) AS already_tasked
  FROM mc_feedback_items f
  WHERE f.status IN ('new', 'verified')
    AND f.remediation_status = 'open'
),
normalized AS (
  SELECT
    c.*,
    CASE
      WHEN c.recurrence_key IS NOT NULL AND c.recurrence_count >= 2 THEN 'high'
      ELSE c.severity
    END AS effective_severity,
    CASE
      WHEN c.recurrence_key IS NOT NULL AND c.recurrence_count >= 2 THEN TRUE
      ELSE FALSE
    END AS hard_rule
  FROM candidates c
),
inserted AS (
  INSERT INTO cortana_tasks (
    source,
    title,
    description,
    priority,
    status,
    auto_executable,
    metadata
  )
  SELECT
    'feedback_loop',
    CASE WHEN n.hard_rule THEN 'HARD RULE: ' || n.summary ELSE n.summary END AS title,
    COALESCE(n.details->>'lesson', n.details->>'context', n.summary) AS description,
    CASE
      WHEN n.effective_severity IN ('critical', 'high') THEN 1
      WHEN n.effective_severity = 'medium' THEN 2
      ELSE 3
    END AS priority,
    CASE
      WHEN n.effective_severity IN ('critical', 'high', 'medium') THEN 'ready'
      ELSE 'backlog'
    END AS status,
    FALSE AS auto_executable,
    jsonb_build_object(
      'feedback_id', n.id::text,
      'recurrence_key', n.recurrence_key,
      'recurrence_count', n.recurrence_count,
      'severity_original', n.severity,
      'severity_effective', n.effective_severity,
      'hard_rule', n.hard_rule,
      'rule_change_candidate', (
        lower(COALESCE(n.summary,'')) ~ '(memory\\.md|agents\\.md|soul\\.md|heartbeat\\.md|system prompt|prompt)'
        OR lower(COALESCE(n.details->>'lesson','')) ~ '(memory\\.md|agents\\.md|soul\\.md|heartbeat\\.md|system prompt|prompt)'
      )
    )
  FROM normalized n
  WHERE NOT n.already_tasked
  RETURNING id, metadata->>'feedback_id' AS feedback_id
),
triaged AS (
  UPDATE mc_feedback_items f
  SET status = 'triaged', updated_at = NOW()
  WHERE f.id IN (
    SELECT i.feedback_id::uuid FROM inserted i
  )
  RETURNING f.id
)
SELECT
  (SELECT COUNT(*) FROM inserted) AS tasks_created,
  (SELECT COUNT(*) FROM triaged) AS feedback_triaged;`;

async function main(): Promise<void> {
  const env = withPostgresPath(process.env);

  const first = spawnSync(PSQL_BIN, [process.env.DB_NAME || "cortana", "-v", "ON_ERROR_STOP=1", "-c", SQL], {
    encoding: "utf8",
    stdio: "inherit",
    env,
  });
  if ((first.status ?? 1) !== 0) process.exit(first.status ?? 1);

  const second = spawnSync(
    PSQL_BIN,
    [
      process.env.DB_NAME || "cortana",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT t.id, t.priority, t.status, t.title, t.metadata->>'feedback_id' AS feedback_id
FROM cortana_tasks t
WHERE t.source = 'feedback_loop'
ORDER BY t.id DESC
LIMIT 50;`,
    ],
    { encoding: "utf8", stdio: "inherit", env }
  );
  if ((second.status ?? 1) !== 0) process.exit(second.status ?? 1);
}

main();
