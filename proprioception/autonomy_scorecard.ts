#!/usr/bin/env npx tsx
import { execFileSync } from 'node:child_process';

const PSQL_BIN = '/opt/homebrew/opt/postgresql@17/bin/psql';
const DEFAULT_WEIGHTS: Record<string, number> = {
  self_heal_rate: 0.2,
  proactive_hit_rate: 0.15,
  task_completion_rate: 0.2,
  correction_frequency_score: 0.1,
  response_quality_score: 0.15,
  memory_accuracy: 0.1,
  uptime_score: 0.1,
};

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function runSqlJson(sql: string): any {
  const out = execFileSync(PSQL_BIN, ['cortana', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGHOST: process.env.PGHOST ?? 'localhost', PGUSER: process.env.PGUSER ?? process.env.USER ?? 'hd' } }).trim();
  return out ? JSON.parse(out) : {};
}

function collectMetricCounts(windowDays: number) {
  const sql = `WITH params AS (SELECT NOW() - INTERVAL '${Math.trunc(windowDays)} days' AS since_ts), incident_counts AS (SELECT COUNT(*) FILTER (WHERE auto_resolved = TRUE) AS auto_resolved, COUNT(*) FILTER (WHERE escalated_to_human = TRUE) AS escalated, COUNT(*) AS total FROM cortana_autonomy_incidents a, params p WHERE a.timestamp >= p.since_ts), legacy_autoheal AS (SELECT COUNT(*) FILTER (WHERE event_type IN ('auto_heal', 'heartbeat_auto_remediation')) AS auto_resolved, COUNT(*) FILTER (WHERE event_type IN ('human_escalation', 'human_intervention_required', 'needs_human')) AS escalated FROM cortana_events e, params p WHERE e.timestamp >= p.since_ts), proactive AS (SELECT COUNT(*) FILTER (WHERE status IN ('useful', 'acted_on')) AS hits, COUNT(*) FILTER (WHERE status <> 'pending') AS decided FROM cortana_proactive_suggestions s, params p WHERE s.timestamp >= p.since_ts), auto_tasks AS (SELECT COUNT(*) FILTER (WHERE auto_executable = TRUE) AS total_auto, COUNT(*) FILTER (WHERE auto_executable = TRUE AND status = 'done' AND COALESCE(assigned_to, '') NOT IN ('hamel', 'human')) AS done_auto FROM cortana_tasks t, params p WHERE t.created_at >= p.since_ts), corrections AS (SELECT COUNT(*) AS correction_count FROM cortana_feedback f, params p WHERE f.timestamp >= p.since_ts AND f.feedback_type IN ('correction', 'behavior', 'tone', 'fact', 'preference')), responses AS (SELECT COUNT(*) FILTER (WHERE outcome = 'success') AS success_count, COUNT(*) FILTER (WHERE outcome = 'partial') AS partial_count, COUNT(*) FILTER (WHERE outcome = 'fail') AS fail_count, COUNT(*) AS total FROM cortana_response_evaluations r, params p WHERE r.timestamp >= p.since_ts), memory_checks AS (SELECT COUNT(*) FILTER (WHERE correct = TRUE) AS correct_count, COUNT(*) AS total FROM cortana_memory_recall_checks m, params p WHERE m.timestamp >= p.since_ts), heartbeat_crons AS (SELECT COUNT(*) FILTER (WHERE status = 'ok') AS ok_count, COUNT(*) AS total FROM cortana_cron_health c, params p WHERE c.timestamp >= p.since_ts AND c.cron_name ILIKE '%heartbeat%'), all_crons AS (SELECT COUNT(*) FILTER (WHERE status = 'ok') AS ok_count, COUNT(*) AS total FROM cortana_cron_health c, params p WHERE c.timestamp >= p.since_ts) SELECT json_build_object('incident_auto_resolved', COALESCE((SELECT auto_resolved FROM incident_counts), 0) + COALESCE((SELECT auto_resolved FROM legacy_autoheal), 0), 'incident_escalated', COALESCE((SELECT escalated FROM incident_counts), 0) + COALESCE((SELECT escalated FROM legacy_autoheal), 0), 'proactive_hits', COALESCE((SELECT hits FROM proactive), 0), 'proactive_decided', COALESCE((SELECT decided FROM proactive), 0), 'auto_tasks_done', COALESCE((SELECT done_auto FROM auto_tasks), 0), 'auto_tasks_total', COALESCE((SELECT total_auto FROM auto_tasks), 0), 'correction_count', COALESCE((SELECT correction_count FROM corrections), 0), 'response_success', COALESCE((SELECT success_count FROM responses), 0), 'response_partial', COALESCE((SELECT partial_count FROM responses), 0), 'response_fail', COALESCE((SELECT fail_count FROM responses), 0), 'response_total', COALESCE((SELECT total FROM responses), 0), 'memory_correct', COALESCE((SELECT correct_count FROM memory_checks), 0), 'memory_total', COALESCE((SELECT total FROM memory_checks), 0), 'heartbeat_ok', COALESCE((SELECT ok_count FROM heartbeat_crons), 0), 'heartbeat_total', COALESCE((SELECT total FROM heartbeat_crons), 0), 'cron_ok', COALESCE((SELECT ok_count FROM all_crons), 0), 'cron_total', COALESCE((SELECT total FROM all_crons), 0));`;
  return runSqlJson(sql);
}

export function computeAndStoreScorecard(windowDays = 7, dryRun = false) {
  const counts = collectMetricCounts(windowDays);
  const incidentTotal = counts.incident_auto_resolved + counts.incident_escalated;
  const metrics = {
    self_heal_rate: clamp(incidentTotal === 0 ? 100 : (counts.incident_auto_resolved / incidentTotal) * 100),
    proactive_hit_rate: clamp(counts.proactive_decided === 0 ? 100 : (counts.proactive_hits / counts.proactive_decided) * 100),
    task_completion_rate: clamp(counts.auto_tasks_total === 0 ? 100 : (counts.auto_tasks_done / counts.auto_tasks_total) * 100),
    correction_frequency_score: clamp(100 - ((counts.correction_count / Math.max(windowDays, 1)) * 50)),
    response_quality_score: clamp(counts.response_total === 0 ? 100 : (((counts.response_success * 1) + (counts.response_partial * 0.5)) / counts.response_total) * 100),
    memory_accuracy: clamp(counts.memory_total === 0 ? 100 : (counts.memory_correct / counts.memory_total) * 100),
    uptime_score: clamp(((counts.heartbeat_total === 0 ? 100 : (counts.heartbeat_ok / counts.heartbeat_total) * 100) * 0.7) + ((counts.cron_total === 0 ? 100 : (counts.cron_ok / counts.cron_total) * 100) * 0.3)),
  };
  const rounded = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  const score = Math.round(clamp(Object.entries(DEFAULT_WEIGHTS).reduce((acc, [k, w]) => acc + (rounded[k] * w), 0)) * 100) / 100;
  const scorecard = { timestamp: new Date().toISOString(), window_days: windowDays, score, weights: DEFAULT_WEIGHTS, metrics: rounded, counts };

  if (!dryRun) {
    const m = rounded as any;
    const sql = `INSERT INTO cortana_autonomy_scorecard_snapshots (window_days, score, self_heal_rate, proactive_hit_rate, task_completion_rate, correction_frequency_score, response_quality_score, memory_accuracy, uptime_score, metrics, weights) VALUES (${Math.trunc(windowDays)}, ${score}, ${m.self_heal_rate}, ${m.proactive_hit_rate}, ${m.task_completion_rate}, ${m.correction_frequency_score}, ${m.response_quality_score}, ${m.memory_accuracy}, ${m.uptime_score}, '${JSON.stringify(scorecard).replace(/'/g, "''")}'::jsonb, '${JSON.stringify(DEFAULT_WEIGHTS).replace(/'/g, "''")}'::jsonb); UPDATE cortana_self_model SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('autonomy_scorecard', jsonb_build_object('score', ${score}, 'window_days', ${Math.trunc(windowDays)}, 'updated_at', NOW(), 'metrics', '${JSON.stringify(rounded).replace(/'/g, "''")}'::jsonb, 'counts', '${JSON.stringify(counts).replace(/'/g, "''")}'::jsonb)), updated_at = NOW() WHERE id = 1;`;
    execFileSync(PSQL_BIN, ['cortana', '-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: { ...process.env, PGHOST: process.env.PGHOST ?? 'localhost', PGUSER: process.env.PGUSER ?? process.env.USER ?? 'hd' } });
  }
  return scorecard;
}

async function main() {
  const args = process.argv.slice(2);
  const windowDays = Number(args[args.indexOf('--window-days') + 1] ?? 7);
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');
  const scorecard = computeAndStoreScorecard(windowDays, dryRun);
  if (asJson || dryRun) console.log(JSON.stringify(scorecard, null, 2));
  else console.log(`Autonomy score: ${scorecard.score.toFixed(2)} (window=${windowDays}d)`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
