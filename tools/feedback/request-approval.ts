#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import db from "../lib/db.js";
const { withPostgresPath } = db;
import { PSQL_BIN } from "../lib/paths.js";

function q(db: string, sql: string): string {
  const r = spawnSync(PSQL_BIN, [db, "-tAc", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: withPostgresPath(process.env),
  });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
  return (r.stdout ?? "").trim();
}

async function main(): Promise<void> {
  const db = process.env.DB_NAME || "cortana";
  const taskId = process.argv[2] ?? "";

  if (!taskId) {
    console.log(`Usage: ${process.argv[1] ?? "request-approval.ts"} <task_id>`);
    process.exit(1);
  }

  const tableExists = q(db, "SELECT to_regclass('public.mc_approval_requests') IS NOT NULL;");
  if (tableExists !== "t") {
    console.log("mc_approval_requests not found. Check Mission Control schema in ~/Developer/cortana-external/apps/mission-control/lib/approvals.ts");
    process.exit(2);
  }

  const ruleChange = q(
    db,
    `WITH t AS (
  SELECT id, title, description, metadata
  FROM cortana_tasks
  WHERE id = ${taskId}
)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM t
  WHERE
    lower(coalesce(title,'')) ~ '(memory\\.md|agents\\.md|soul\\.md|heartbeat\\.md|system prompt|prompt)'
    OR lower(coalesce(description,'')) ~ '(memory\\.md|agents\\.md|soul\\.md|heartbeat\\.md|system prompt|prompt)'
    OR coalesce((metadata->>'rule_change_candidate')::boolean, false)
) THEN 't' ELSE 'f' END;`
  );

  if (ruleChange !== "t") {
    console.log(`Task ${taskId} is not a rule-change candidate. No approval required.`);
    process.exit(0);
  }

  const existing = q(
    db,
    `SELECT id
FROM mc_approval_requests
WHERE action_type = 'rule_change'
  AND proposal->>'task_id' = '${taskId}'
  AND status IN ('pending','approved','approved_edited')
ORDER BY created_at DESC
LIMIT 1;`
  ).replace(/ /g, "");

  if (existing) {
    console.log(`Approval already exists for task ${taskId}: ${existing}`);
    process.exit(0);
  }

  const sql = `
WITH t AS (
  SELECT id, title, description, metadata
  FROM cortana_tasks
  WHERE id = ${taskId}
), ins AS (
  INSERT INTO mc_approval_requests (
    task_id,
    agent_id,
    action_type,
    proposal,
    rationale,
    risk_level,
    auto_approvable,
    status,
    expires_at,
    resume_payload
  )
  SELECT
    NULL,
    'cortana',
    'rule_change',
    jsonb_build_object(
      'task_id', t.id,
      'title', t.title,
      'description', t.description,
      'metadata', t.metadata
    ),
    'Rule/system memory modification detected from feedback-linked task; explicit approval required before execution.',
    'p1',
    FALSE,
    'pending',
    NOW() + INTERVAL '72 hours',
    jsonb_build_object('task_id', t.id)
  FROM t
  RETURNING id
)
INSERT INTO mc_approval_events (approval_id, event_type, actor, payload)
SELECT ins.id, 'created', 'cortana', jsonb_build_object('task_id', ${taskId}, 'source', 'feedback-loop')
FROM ins;
`;

  const ins = spawnSync(PSQL_BIN, [db, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    stdio: "inherit",
    env: withPostgresPath(process.env),
  });
  if ((ins.status ?? 1) !== 0) process.exit(ins.status ?? 1);

  console.log(`Created approval request for task ${taskId}`);
}

main();
