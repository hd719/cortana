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

  const feedbackTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM cortana_feedback;"]);
  const mcTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM mc_feedback_items;"]);
  const feedbackTasksTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM cortana_tasks WHERE source = 'feedback';"]);
  const feedbackLoopTasksTotal = psql(db, ["-t", "-A", "-c", "SELECT COUNT(*) FROM cortana_tasks WHERE source = 'feedback_loop';"]);

  const lagCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM cortana_feedback f
WHERE NOT EXISTS (
  SELECT 1
  FROM mc_feedback_items m
  WHERE COALESCE(m.summary,'') = COALESCE(f.context,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
);`]);

  const stuckCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
LEFT JOIN LATERAL (
  SELECT f.id, f.applied
  FROM cortana_feedback f
  WHERE COALESCE(f.context,'') = COALESCE(m.summary,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
  ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) ASC
  LIMIT 1
) cf ON TRUE
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND (
    COALESCE(cf.applied, FALSE) = FALSE
    OR NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
  );`]);

  const stuckBacklogCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
LEFT JOIN LATERAL (
  SELECT f.id, f.applied
  FROM cortana_feedback f
  WHERE COALESCE(f.context,'') = COALESCE(m.summary,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
  ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) ASC
  LIMIT 1
) cf ON TRUE
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND COALESCE(cf.id, 0) <> 0
  AND COALESCE(cf.applied, FALSE) = FALSE
  AND EXISTS (
    SELECT 1
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  );`]);

  const stuckBreakageCount = psql(db, ["-t", "-A", "-c", `SELECT COUNT(*)
FROM mc_feedback_items m
LEFT JOIN LATERAL (
  SELECT f.id, f.applied
  FROM cortana_feedback f
  WHERE COALESCE(f.context,'') = COALESCE(m.summary,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
  ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) ASC
  LIMIT 1
) cf ON TRUE
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND (
    COALESCE(cf.id, 0) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
  );`]);

  const lagRows = psql(db, ["-t", "-A", "-F", "\t", "-c", `SELECT
  f.id::text,
  to_char(f.timestamp AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS feedback_ts_et,
  LEFT(COALESCE(f.context,''), 120) AS context
FROM cortana_feedback f
WHERE NOT EXISTS (
  SELECT 1
  FROM mc_feedback_items m
  WHERE COALESCE(m.summary,'') = COALESCE(f.context,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
)
ORDER BY f.timestamp ASC
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
LEFT JOIN LATERAL (
  SELECT f.id, f.applied
  FROM cortana_feedback f
  WHERE COALESCE(f.context,'') = COALESCE(m.summary,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
  ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) ASC
  LIMIT 1
) cf ON TRUE
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND (
    COALESCE(cf.applied, FALSE) = FALSE
    OR NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
  )
ORDER BY m.created_at ASC
LIMIT 10;`]);

  const lagN = Number(lagCount || "0");
  const stuckN = Number(stuckCount || "0");
  const stuckBacklogN = Number(stuckBacklogCount || "0");
  const stuckBreakageN = Number(stuckBreakageCount || "0");

  const severity = stuckBreakageN > 0 ? "warning" : "info";
  const message = `pipeline reconciliation: feedback=${feedbackTotal}, mc_feedback_items=${mcTotal}, tasks_source_feedback=${feedbackTasksTotal}, lag=${lagN}, stuck=${stuckN}, stuck_backlog=${stuckBacklogN}, stuck_breakage=${stuckBreakageN}`;

  const insertSql = `
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'feedback_pipeline_reconciliation',
  'pipeline-reconciliation.sh',
  '${severity}',
  '${esc(message)}',
  jsonb_build_object(
    'feedback_total', ${feedbackTotal || 0},
    'mc_feedback_items_total', ${mcTotal || 0},
    'cortana_tasks_source_feedback_total', ${feedbackTasksTotal || 0},
    'cortana_tasks_source_feedback_loop_total', ${feedbackLoopTasksTotal || 0},
    'lag_count', ${lagN},
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
  console.log(`- cortana_feedback: ${feedbackTotal}`);
  console.log(`- mc_feedback_items: ${mcTotal}`);
  console.log(`- cortana_tasks (source='feedback'): ${feedbackTasksTotal}`);
  console.log(`- cortana_tasks (source='feedback_loop'): ${feedbackLoopTasksTotal}`);
  console.log("");
  console.log("Gaps:");
  console.log(`- Lag (in cortana_feedback, missing in mc_feedback_items): ${lagN}`);
  console.log(`- Stuck >24h total: ${stuckN}`);
  console.log(`  - Backlog (matched + task linked, waiting apply): ${stuckBacklogN}`);
  console.log(`  - Breakage (missing match and/or missing linked task): ${stuckBreakageN}`);
  console.log("");
  console.log("Lag sample (up to 10):");
  console.log("id\tfeedback_ts_et\tcontext");
  console.log(lagRows || "<none>");
  console.log("");
  console.log("Stuck sample (up to 10):");
  console.log("id\tcreated_et\tstatus\tremediation_status\tsummary\tlinked_task_id");
  console.log(stuckRows || "<none>");
  console.log("");
  console.log(`Logged cortana_events event_type='feedback_pipeline_reconciliation' severity='${severity}'.`);
}

main();
