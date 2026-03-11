#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonMap = Record<string, any>;

type AutonomyScorecard = {
  windowHours: number;
  counts: {
    autoFixAttempted: number;
    autoFixSucceeded: number;
    escalations: number;
    blockedOrExceededAuthority: number;
    staleReportSuppressions: number;
    familyCriticalFailures: number;
  };
  activeFollowUps: Array<{
    system: string;
    status: string;
    detail: string;
    taskId: number | null;
    createdAt: string;
  }>;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const DB = process.env.CORTANA_DB ?? "cortana";

function runPsqlJson(sql: string): JsonMap {
  const proc = spawnSync("/opt/homebrew/opt/postgresql@17/bin/psql", [DB, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
  }
  const raw = String(proc.stdout ?? "").trim() || "{}";
  return JSON.parse(raw) as JsonMap;
}

export function collectAutonomyScorecard(windowHours = 168): AutonomyScorecard {
  const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.floor(windowHours) : 168;
  const sql = `
WITH recent AS (
  SELECT
    timestamp,
    event_type,
    COALESCE(metadata->>'system', metadata->>'followup_system', 'unknown') AS system,
    COALESCE(metadata->>'status', '') AS status,
    COALESCE(metadata->>'detail', message, '') AS detail,
    NULLIF(metadata->>'followup_task_id', '')::int AS followup_task_id,
    COALESCE((metadata->>'family_critical')::boolean, false) AS family_critical
  FROM cortana_events
  WHERE source = 'autonomy-remediation'
    AND event_type IN ('autonomy_action_result', 'autonomy_followup_suppressed')
    AND timestamp >= NOW() - INTERVAL '${hours} hours'
), latest_open AS (
  SELECT DISTINCT ON (system)
    system,
    status,
    detail,
    followup_task_id,
    timestamp
  FROM recent
  WHERE event_type = 'autonomy_action_result'
  ORDER BY system, timestamp DESC
)
SELECT json_build_object(
  'windowHours', ${hours},
  'counts', json_build_object(
    'autoFixAttempted', (SELECT COUNT(*) FROM recent WHERE event_type = 'autonomy_action_result' AND status IN ('remediated','escalate')),
    'autoFixSucceeded', (SELECT COUNT(*) FROM recent WHERE event_type = 'autonomy_action_result' AND status = 'remediated'),
    'escalations', (SELECT COUNT(*) FROM recent WHERE event_type = 'autonomy_action_result' AND status = 'escalate'),
    'blockedOrExceededAuthority', (SELECT COUNT(*) FROM recent WHERE event_type = 'autonomy_action_result' AND status = 'skipped'),
    'staleReportSuppressions', (SELECT COUNT(*) FROM recent WHERE event_type = 'autonomy_followup_suppressed'),
    'familyCriticalFailures', (SELECT COUNT(*) FROM recent WHERE event_type = 'autonomy_action_result' AND status = 'escalate' AND family_critical)
  ),
  'activeFollowUps', COALESCE((
    SELECT json_agg(json_build_object(
      'system', l.system,
      'status', l.status,
      'detail', l.detail,
      'taskId', l.followup_task_id,
      'createdAt', l.timestamp
    ) ORDER BY l.timestamp DESC)
    FROM latest_open l
    WHERE l.status IN ('escalate','skipped')
  ), '[]'::json)
)::text;
`;

  const parsed = runPsqlJson(sql);
  return {
    windowHours: Number(parsed.windowHours ?? hours),
    counts: {
      autoFixAttempted: Number(parsed.counts?.autoFixAttempted ?? 0),
      autoFixSucceeded: Number(parsed.counts?.autoFixSucceeded ?? 0),
      escalations: Number(parsed.counts?.escalations ?? 0),
      blockedOrExceededAuthority: Number(parsed.counts?.blockedOrExceededAuthority ?? 0),
      staleReportSuppressions: Number(parsed.counts?.staleReportSuppressions ?? 0),
      familyCriticalFailures: Number(parsed.counts?.familyCriticalFailures ?? 0),
    },
    activeFollowUps: Array.isArray(parsed.activeFollowUps) ? parsed.activeFollowUps.map((item: any) => ({
      system: String(item.system ?? "unknown"),
      status: String(item.status ?? "unknown"),
      detail: String(item.detail ?? ""),
      taskId: typeof item.taskId === 'number' ? item.taskId : item.taskId ? Number(item.taskId) : null,
      createdAt: String(item.createdAt ?? ""),
    })) : [],
  };
}

function main() {
  const payload = collectAutonomyScorecard();
  console.log(JSON.stringify(payload, null, 2));
}

main();
