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
  incidentReviews: Array<{
    system: string;
    lane: string;
    familyCritical: boolean;
    status: string;
    whatFailed: string;
    actionTaken: string;
    verificationStatus: string;
    recovered: boolean;
    followUp: string;
    policyLesson: string;
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
  ), '[]'::json),
  'incidentReviews', COALESCE((
    SELECT json_agg(json_build_object(
      'system', COALESCE(r.metadata->>'system', 'unknown'),
      'lane', COALESCE(r.metadata->>'lane_label', CASE WHEN COALESCE((r.metadata->>'family_critical')::boolean, false) THEN 'family-critical' ELSE 'routine' END),
      'familyCritical', COALESCE((r.metadata->>'family_critical')::boolean, false),
      'status', COALESCE(r.metadata->>'status', ''),
      'whatFailed', COALESCE(r.metadata->>'detail', r.message, ''),
      'actionTaken', COALESCE(r.metadata->>'action', 'none'),
      'verificationStatus', COALESCE(r.metadata->>'verification_status', 'uncertain'),
      'recovered', COALESCE(r.metadata->>'status', '') = 'remediated',
      'followUp', COALESCE(r.metadata->>'escalation_path', 'review locally'),
      'policyLesson', COALESCE(r.metadata->>'policy_lesson', 'n/a'),
      'taskId', NULLIF(r.metadata->>'followup_task_id', '')::int,
      'createdAt', r.timestamp
    ) ORDER BY r.timestamp DESC)
    FROM cortana_events r
    WHERE r.source = 'autonomy-remediation'
      AND r.event_type = 'autonomy_action_result'
      AND r.timestamp >= NOW() - INTERVAL '${hours} hours'
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
    incidentReviews: Array.isArray(parsed.incidentReviews) ? parsed.incidentReviews.map((item: any) => ({
      system: String(item.system ?? "unknown"),
      lane: String(item.lane ?? "routine"),
      familyCritical: Boolean(item.familyCritical ?? false),
      status: String(item.status ?? "unknown"),
      whatFailed: String(item.whatFailed ?? ""),
      actionTaken: String(item.actionTaken ?? "none"),
      verificationStatus: String(item.verificationStatus ?? "uncertain"),
      recovered: Boolean(item.recovered ?? false),
      followUp: String(item.followUp ?? "review locally"),
      policyLesson: String(item.policyLesson ?? "n/a"),
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
