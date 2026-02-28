#!/usr/bin/env npx tsx

import { runPsql, withPostgresPath } from "../tools/lib/db.js";

const DEFAULT_WEIGHTS: Record<string, number> = {
  self_heal_rate: 0.20,
  proactive_hit_rate: 0.15,
  task_completion_rate: 0.20,
  correction_frequency_score: 0.10,
  response_quality_score: 0.15,
  memory_accuracy: 0.10,
  uptime_score: 0.10,
};

type ScorecardCounts = Record<string, number>;

type Scorecard = {
  timestamp: string;
  window_days: number;
  score: number;
  weights: Record<string, number>;
  metrics: Record<string, number>;
  counts: ScorecardCounts;
};

function clamp(value: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, value));
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function runSqlJson(sql: string): Record<string, number> {
  const env = withPostgresPath({
    ...process.env,
    PGHOST: process.env.PGHOST ?? "localhost",
    PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd",
  });
  const result = runPsql(sql, {
    db: "cortana",
    args: ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
    env,
    stdio: "pipe",
  });

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new Error(`psql failed: ${err}`);
  }

  const raw = (result.stdout || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, number>;
  return parsed;
}

function collectMetricCounts(windowDays: number): ScorecardCounts {
  const sql = `
WITH params AS (
  SELECT NOW() - INTERVAL '${Math.trunc(windowDays)} days' AS since_ts
),
incident_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE auto_resolved = TRUE) AS auto_resolved,
    COUNT(*) FILTER (WHERE escalated_to_human = TRUE) AS escalated,
    COUNT(*) AS total
  FROM cortana_autonomy_incidents a, params p
  WHERE a.timestamp >= p.since_ts
),
legacy_autoheal AS (
  SELECT
    COUNT(*) FILTER (WHERE event_type IN ('auto_heal', 'heartbeat_auto_remediation')) AS auto_resolved,
    COUNT(*) FILTER (WHERE event_type IN ('human_escalation', 'human_intervention_required', 'needs_human')) AS escalated
  FROM cortana_events e, params p
  WHERE e.timestamp >= p.since_ts
),
proactive AS (
  SELECT
    COUNT(*) FILTER (WHERE status IN ('useful', 'acted_on')) AS hits,
    COUNT(*) FILTER (WHERE status <> 'pending') AS decided
  FROM cortana_proactive_suggestions s, params p
  WHERE s.timestamp >= p.since_ts
),
auto_tasks AS (
  SELECT
    COUNT(*) FILTER (WHERE auto_executable = TRUE) AS total_auto,
    COUNT(*) FILTER (
      WHERE auto_executable = TRUE
        AND status = 'done'
        AND COALESCE(assigned_to, '') NOT IN ('hamel', 'human')
    ) AS done_auto
  FROM cortana_tasks t, params p
  WHERE t.created_at >= p.since_ts
),
corrections AS (
  SELECT COUNT(*) AS correction_count
  FROM cortana_feedback f, params p
  WHERE f.timestamp >= p.since_ts
    AND f.feedback_type IN ('correction', 'behavior', 'tone', 'fact', 'preference')
),
responses AS (
  SELECT
    COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
    COUNT(*) FILTER (WHERE outcome = 'partial') AS partial_count,
    COUNT(*) FILTER (WHERE outcome = 'fail') AS fail_count,
    COUNT(*) AS total
  FROM cortana_response_evaluations r, params p
  WHERE r.timestamp >= p.since_ts
),
memory_checks AS (
  SELECT
    COUNT(*) FILTER (WHERE correct = TRUE) AS correct_count,
    COUNT(*) AS total
  FROM cortana_memory_recall_checks m, params p
  WHERE m.timestamp >= p.since_ts
),
heartbeat_crons AS (
  SELECT
    COUNT(*) FILTER (WHERE status = 'ok') AS ok_count,
    COUNT(*) AS total
  FROM cortana_cron_health c, params p
  WHERE c.timestamp >= p.since_ts
    AND c.cron_name ILIKE '%heartbeat%'
),
all_crons AS (
  SELECT
    COUNT(*) FILTER (WHERE status = 'ok') AS ok_count,
    COUNT(*) AS total
  FROM cortana_cron_health c, params p
  WHERE c.timestamp >= p.since_ts
)
SELECT json_build_object(
  'incident_auto_resolved', COALESCE((SELECT auto_resolved FROM incident_counts), 0) + COALESCE((SELECT auto_resolved FROM legacy_autoheal), 0),
  'incident_escalated', COALESCE((SELECT escalated FROM incident_counts), 0) + COALESCE((SELECT escalated FROM legacy_autoheal), 0),
  'proactive_hits', COALESCE((SELECT hits FROM proactive), 0),
  'proactive_decided', COALESCE((SELECT decided FROM proactive), 0),
  'auto_tasks_done', COALESCE((SELECT done_auto FROM auto_tasks), 0),
  'auto_tasks_total', COALESCE((SELECT total_auto FROM auto_tasks), 0),
  'correction_count', COALESCE((SELECT correction_count FROM corrections), 0),
  'response_success', COALESCE((SELECT success_count FROM responses), 0),
  'response_partial', COALESCE((SELECT partial_count FROM responses), 0),
  'response_fail', COALESCE((SELECT fail_count FROM responses), 0),
  'response_total', COALESCE((SELECT total FROM responses), 0),
  'memory_correct', COALESCE((SELECT correct_count FROM memory_checks), 0),
  'memory_total', COALESCE((SELECT total FROM memory_checks), 0),
  'heartbeat_ok', COALESCE((SELECT ok_count FROM heartbeat_crons), 0),
  'heartbeat_total', COALESCE((SELECT total FROM heartbeat_crons), 0),
  'cron_ok', COALESCE((SELECT ok_count FROM all_crons), 0),
  'cron_total', COALESCE((SELECT total FROM all_crons), 0)
);
`;
  return runSqlJson(sql) as ScorecardCounts;
}

export function computeScorecard(windowDays = 7): Scorecard {
  const counts = collectMetricCounts(windowDays);

  const incidentTotal = counts.incident_auto_resolved + counts.incident_escalated;
  const selfHealRate = incidentTotal === 0 ? 100 : (counts.incident_auto_resolved / incidentTotal) * 100;

  const proactiveHitRate = counts.proactive_decided === 0 ? 100 : (counts.proactive_hits / counts.proactive_decided) * 100;

  const taskCompletionRate = counts.auto_tasks_total === 0 ? 100 : (counts.auto_tasks_done / counts.auto_tasks_total) * 100;

  const correctionRatePerDay = counts.correction_count / Math.max(windowDays, 1);
  const correctionFrequencyScore = clamp(100 - correctionRatePerDay * 50);

  let responseQualityScore = 100;
  if (counts.response_total > 0) {
    responseQualityScore =
      ((counts.response_success * 1.0) + (counts.response_partial * 0.5)) / counts.response_total * 100;
  }

  const memoryAccuracy = counts.memory_total === 0 ? 100 : (counts.memory_correct / counts.memory_total) * 100;

  const heartbeatRate = counts.heartbeat_total === 0 ? 100 : (counts.heartbeat_ok / counts.heartbeat_total) * 100;
  const cronRate = counts.cron_total === 0 ? 100 : (counts.cron_ok / counts.cron_total) * 100;
  const uptimeScore = (heartbeatRate * 0.7) + (cronRate * 0.3);

  const metrics = {
    self_heal_rate: Number(clamp(selfHealRate).toFixed(2)),
    proactive_hit_rate: Number(clamp(proactiveHitRate).toFixed(2)),
    task_completion_rate: Number(clamp(taskCompletionRate).toFixed(2)),
    correction_frequency_score: Number(clamp(correctionFrequencyScore).toFixed(2)),
    response_quality_score: Number(clamp(responseQualityScore).toFixed(2)),
    memory_accuracy: Number(clamp(memoryAccuracy).toFixed(2)),
    uptime_score: Number(clamp(uptimeScore).toFixed(2)),
  };

  let score = 0;
  for (const [key, weight] of Object.entries(DEFAULT_WEIGHTS)) {
    score += (metrics as Record<string, number>)[key] * weight;
  }

  return {
    timestamp: new Date().toISOString(),
    window_days: windowDays,
    score: Number(clamp(score).toFixed(2)),
    weights: DEFAULT_WEIGHTS,
    metrics,
    counts,
  };
}

export function computeAndStoreScorecard(windowDays = 7, dryRun = false): Scorecard {
  const scorecard = computeScorecard(windowDays);
  if (!dryRun) {
    const metrics = scorecard.metrics;
    const snapshotPayload = JSON.stringify(scorecard);
    const weightsPayload = JSON.stringify(scorecard.weights);
    const countsPayload = JSON.stringify(scorecard.counts);
    const metricsPayload = JSON.stringify(metrics);

    const sql = `
INSERT INTO cortana_autonomy_scorecard_snapshots (
  window_days, score, self_heal_rate, proactive_hit_rate, task_completion_rate,
  correction_frequency_score, response_quality_score, memory_accuracy, uptime_score,
  metrics, weights
)
VALUES (
  ${Math.trunc(scorecard.window_days)}, ${scorecard.score}, ${metrics.self_heal_rate}, ${metrics.proactive_hit_rate}, ${metrics.task_completion_rate},
  ${metrics.correction_frequency_score}, ${metrics.response_quality_score}, ${metrics.memory_accuracy}, ${metrics.uptime_score},
  '${sqlEscape(snapshotPayload)}'::jsonb, '${sqlEscape(weightsPayload)}'::jsonb
);

UPDATE cortana_self_model
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
  'autonomy_scorecard', jsonb_build_object(
    'score', ${scorecard.score},
    'window_days', ${Math.trunc(scorecard.window_days)},
    'updated_at', NOW(),
    'metrics', '${sqlEscape(metricsPayload)}'::jsonb,
    'counts', '${sqlEscape(countsPayload)}'::jsonb
  )
),
updated_at = NOW()
WHERE id = 1;
`;

    const env = withPostgresPath({
      ...process.env,
      PGHOST: process.env.PGHOST ?? "localhost",
      PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd",
    });

    const result = runPsql(sql, {
      db: "cortana",
      args: ["-X", "-v", "ON_ERROR_STOP=1"],
      env,
      stdio: "pipe",
    });

    if (result.status !== 0) {
      const err = (result.stderr || result.stdout || "").trim();
      throw new Error(`failed storing autonomy scorecard: ${err}`);
    }
  }
  return scorecard;
}

type Args = {
  windowDays: number;
  dryRun: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    windowDays: 7,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--window-days") {
      const next = argv[i + 1];
      if (next) {
        out.windowDays = Number.parseInt(next, 10);
        i += 1;
      }
    } else if (arg.startsWith("--window-days=")) {
      out.windowDays = Number.parseInt(arg.split("=")[1] || "7", 10);
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--json") {
      out.json = true;
    }
  }

  return out;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const scorecard = computeAndStoreScorecard(args.windowDays, args.dryRun);

  if (args.json || args.dryRun) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(`Autonomy score: ${scorecard.score.toFixed(2)} (window=${args.windowDays}d)`);
  }

  return 0;
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
