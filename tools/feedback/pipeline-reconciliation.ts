#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

function psql(db: string, args: string[]): string {
  const r = spawnSync(PSQL_BIN, [db, "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: withPostgresPath(process.env),
  });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
  return (r.stdout ?? "").trim();
}

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

function runDate(): string {
  const d = spawnSync("date", ["+%Y-%m-%d %H:%M:%S %Z"], { encoding: "utf8" });
  return (d.stdout ?? "").trim();
}

async function main(): Promise<void> {
  const db = process.env.DB_NAME || "cortana";

  const mcTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM mc_feedback_items;"]);
  const feedbackTasksTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM cortana_tasks WHERE source = 'feedback';"]);
  const feedbackLoopTasksTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM cortana_tasks WHERE source = 'feedback_loop';"]);

  const unlinkedCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
WHERE COALESCE(m.remediation_status, 'open') NOT IN ('resolved', 'wont_fix')
  AND NOT EXISTS (
    SELECT 1
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  );`]);

  const stuckCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND COALESCE(m.remediation_status, 'open') NOT IN ('resolved', 'wont_fix')
  AND (
    NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
    OR COALESCE(m.status, 'new') IN ('new', 'triaged', 'verified')
  );`]);

  const stuckBacklogCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND COALESCE(m.remediation_status, 'open') NOT IN ('resolved', 'wont_fix')
  AND EXISTS (
    SELECT 1
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  );`]);

  const stuckBreakageCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND COALESCE(m.remediation_status, 'open') NOT IN ('resolved', 'wont_fix')
  AND NOT EXISTS (
    SELECT 1
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  );`]);

  const unlinkedRows = psql(db, ["-t", "-A", "-F", "\t", "-c", `SELECT
  m.id::text,
  to_char(m.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS created_et,
  COALESCE(m.category, '') AS category,
  COALESCE(m.severity, '') AS severity,
  LEFT(COALESCE(m.summary,''), 120) AS summary
FROM mc_feedback_items m
WHERE COALESCE(m.remediation_status, 'open') NOT IN ('resolved', 'wont_fix')
  AND NOT EXISTS (
    SELECT 1
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  )
ORDER BY m.created_at ASC
LIMIT 10;`]);

  const stuckRows = psql(db, ["-t", "-A", "-F", "\t", "-c", `SELECT
  m.id::text,
  to_char(m.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS created_et,
  COALESCE(m.status, '') AS status,
  COALESCE(m.remediation_status, '') AS remediation_status,
  LEFT(COALESCE(m.summary,''), 100) AS summary,
  COALESCE((
    SELECT MIN(t.id)::text
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  ), '') AS linked_task_id
FROM mc_feedback_items m
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND COALESCE(m.remediation_status, 'open') NOT IN ('resolved', 'wont_fix')
  AND (
    NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
    OR COALESCE(m.status, 'new') IN ('new', 'triaged', 'verified')
  )
ORDER BY m.created_at ASC
LIMIT 10;`]);

  const unlinkedN = Number(unlinkedCount || "0");
  const stuckN = Number(stuckCount || "0");
  const stuckBacklogN = Number(stuckBacklogCount || "0");
  const stuckBreakageN = Number(stuckBreakageCount || "0");

  const severity = stuckBreakageN > 0 ? "warning" : "info";
  const message = `pipeline reconciliation: mc_feedback_items=${mcTotal}, tasks_source_feedback=${feedbackTasksTotal}, unlinked=${unlinkedN}, stuck=${stuckN}, stuck_backlog=${stuckBacklogN}, stuck_breakage=${stuckBreakageN}`;

  const insertSql = `
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'feedback_pipeline_reconciliation',
  'pipeline-reconciliation.sh',
  '${esc(severity)}',
  '${esc(message)}',
  jsonb_build_object(
    'mc_feedback_items_total', ${mcTotal || 0},
    'cortana_tasks_source_feedback_total', ${feedbackTasksTotal || 0},
    'cortana_tasks_source_feedback_loop_total', ${feedbackLoopTasksTotal || 0},
    'unlinked_count', ${unlinkedN},
    'stuck_count', ${stuckN},
    'stuck_backlog_count', ${stuckBacklogN},
    'stuck_breakage_count', ${stuckBreakageN},
    'generated_at', NOW()
  )
);
`;
  const ins = spawnSync(PSQL_BIN, [db, "-v", "ON_ERROR_STOP=1", "-c", insertSql], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "inherit"],
    env: withPostgresPath(process.env),
  });
  if ((ins.status ?? 1) !== 0) process.exit(ins.status ?? 1);

  console.log("=== Feedback Pipeline Reconciliation ===");
  console.log(`Generated: ${runDate()}`);
  console.log("");
  console.log("Stage counts:");
  console.log(`- mc_feedback_items: ${mcTotal}`);
  console.log(`- cortana_tasks (source='feedback'): ${feedbackTasksTotal}`);
  console.log(`- cortana_tasks (source='feedback_loop'): ${feedbackLoopTasksTotal}`);
  console.log("");
  console.log("Gaps:");
  console.log(`- Unlinked feedback items (missing task): ${unlinkedN}`);
  console.log(`- Stuck >24h total: ${stuckN}`);
  console.log(`  - Backlog (task linked, unresolved): ${stuckBacklogN}`);
  console.log(`  - Breakage (missing linked task): ${stuckBreakageN}`);
  console.log("");
  console.log("Unlinked sample (up to 10):");
  console.log("id\tcreated_et\tcategory\tseverity\tsummary");
  console.log(unlinkedRows || "<none>");
  console.log("");
  console.log("Stuck sample (up to 10):");
  console.log("id\tcreated_et\tstatus\tremediation_status\tsummary\tlinked_task_id");
  console.log(stuckRows || "<none>");
  console.log("");
  console.log(`Logged cortana_events event_type='feedback_pipeline_reconciliation' severity='${severity}'.`);
}

main();
