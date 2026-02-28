#!/usr/bin/env npx tsx

import { runPsql, withPostgresPath } from "../lib/db.js";

function sqlEscape(val: string): string {
  return (val || "").replaceAll("'", "''");
}

export function recordRun(runId: string, mode: string, scenarioCount: number, status: string, metadata: Record<string, unknown>): void {
  const sql =
    "INSERT INTO cortana_chaos_runs (run_id, mode, scenario_count, status, metadata) " +
    `VALUES ('${sqlEscape(runId)}', '${sqlEscape(mode)}', ${scenarioCount}, '${sqlEscape(status)}', ` +
    `'${sqlEscape(JSON.stringify(metadata))}'::jsonb) ` +
    "ON CONFLICT (run_id) DO UPDATE SET " +
    "mode = EXCLUDED.mode, scenario_count = EXCLUDED.scenario_count, status = EXCLUDED.status, metadata = EXCLUDED.metadata;";
  execSql(sql);
}

export function recordEvents(runId: string, events: Array<Record<string, any>>): void {
  if (!events.length) return;
  const stmts: string[] = [];
  for (const e of events) {
    stmts.push(
      "INSERT INTO cortana_chaos_events (run_id, scenario_name, fault_type, injected, detected, recovered, detection_ms, recovery_ms, notes, metadata) " +
        `VALUES ('${sqlEscape(runId)}', '${sqlEscape(String(e.name))}', '${sqlEscape(String(e.fault_type))}', ` +
        `${String(Boolean(e.injected))}, ${String(Boolean(e.detected))}, ${String(Boolean(e.recovered))}, ` +
        `${Number.parseInt(String(e.detection_ms), 10)}, ${Number.parseInt(String(e.recovery_ms), 10)}, '${sqlEscape(String(e.notes ?? ""))}', ` +
        `'${sqlEscape(JSON.stringify(e.metadata ?? {}))}'::jsonb);`
    );
  }
  execSql(stmts.join("\n"));
}

export function fetchMttrScorecard(windowDays = 30): Record<string, unknown> {
  const sql = `
WITH filtered AS (
  SELECT *
  FROM cortana_chaos_events
  WHERE started_at >= NOW() - INTERVAL '${Math.trunc(windowDays)} days'
), scored AS (
  SELECT
    fault_type,
    COUNT(*) AS runs,
    AVG(detection_ms)::int AS avg_detection_ms,
    AVG(recovery_ms)::int AS avg_recovery_ms,
    ROUND(100.0 * AVG(CASE WHEN recovered THEN 1 ELSE 0 END), 2) AS recovery_rate
  FROM filtered
  GROUP BY fault_type
)
SELECT COALESCE(json_agg(row_to_json(scored)), '[]'::json) FROM scored;
`;
  const out = queryScalar(sql);
  const rows = out ? JSON.parse(out) : [];
  return { window_days: windowDays, fault_types: rows };
}

function execSql(sql: string): void {
  const proc = runPsql(sql, {
    db: "cortana",
    args: ["-X", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath({ ...process.env, PGHOST: process.env.PGHOST ?? "localhost", PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd" }),
  });
  if (proc.status !== 0) {
    throw new Error(`psql write failed: ${(proc.stderr || "").trim()}`);
  }
}

function queryScalar(sql: string): string {
  const proc = runPsql(sql, {
    db: "cortana",
    args: ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath({ ...process.env, PGHOST: process.env.PGHOST ?? "localhost", PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd" }),
  });
  if (proc.status !== 0) {
    throw new Error(`psql query failed: ${(proc.stderr || "").trim()}`);
  }
  return (proc.stdout || "").trim();
}
