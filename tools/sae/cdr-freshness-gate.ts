#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { PSQL_BIN } from "../lib/paths.js";

const DB_NAME = process.env.DB_NAME || "cortana";
const MAX_AGE_MINUTES = Number(process.env.SAE_MAX_AGE_MINUTES || 90);
const MAX_ERROR_RATIO = Number(process.env.SAE_MAX_ERROR_RATIO || 0.3);
const MIN_DOMAINS = Number(process.env.SAE_MIN_DOMAINS || 3);

type RunRow = {
  run_id: string;
  status: string;
  completed_at: string | null;
  actual_domains: string[] | null;
  total_keys: number | null;
  error_count: number | null;
};

type GateSummary = {
  ok: boolean;
  shouldProceed: boolean;
  reason: string;
  thresholds: {
    maxAgeMinutes: number;
    maxErrorRatioExclusive: number;
    minDomains: number;
  };
  run: RunRow | null;
  checks: {
    fresh: boolean;
    errorRatioOk: boolean;
    domainCountOk: boolean;
  };
  metrics: {
    ageMinutes: number | null;
    errorRatio: number | null;
    domainCount: number;
    totalKeys: number;
    errorCount: number;
  };
};

function withPostgresPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `/opt/homebrew/opt/postgresql@17/bin:${env.PATH ?? ""}`,
  };
}

function runPsql(sql: string): string {
  const proc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });

  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
  }

  return (proc.stdout || "").trim();
}

function loadLatestCompletedRun(): RunRow | null {
  const sql = `
    SELECT COALESCE(row_to_json(t), '{}'::json)::text
    FROM (
      SELECT run_id, status, completed_at, actual_domains, total_keys, error_count
      FROM cortana_sitrep_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1
    ) t;
  `;

  const out = runPsql(sql);
  if (!out || out === "{}") return null;
  return JSON.parse(out) as RunRow;
}

export function evaluateFreshnessGate(now = new Date()): GateSummary {
  const run = loadLatestCompletedRun();

  if (!run) {
    return {
      ok: false,
      shouldProceed: false,
      reason: "no_completed_run",
      thresholds: {
        maxAgeMinutes: MAX_AGE_MINUTES,
        maxErrorRatioExclusive: MAX_ERROR_RATIO,
        minDomains: MIN_DOMAINS,
      },
      run: null,
      checks: { fresh: false, errorRatioOk: false, domainCountOk: false },
      metrics: { ageMinutes: null, errorRatio: null, domainCount: 0, totalKeys: 0, errorCount: 0 },
    };
  }

  const completedAt = run.completed_at ? new Date(run.completed_at) : null;
  const ageMinutes = completedAt ? (now.getTime() - completedAt.getTime()) / 60000 : Number.POSITIVE_INFINITY;
  const totalKeys = run.total_keys ?? 0;
  const errorCount = run.error_count ?? 0;
  const errorRatio = totalKeys > 0 ? errorCount / totalKeys : 1;
  const domainCount = new Set((run.actual_domains || []).filter(Boolean)).size;

  const checks = {
    fresh: ageMinutes <= MAX_AGE_MINUTES,
    errorRatioOk: errorRatio < MAX_ERROR_RATIO,
    domainCountOk: domainCount >= MIN_DOMAINS,
  };

  const shouldProceed = checks.fresh && checks.errorRatioOk && checks.domainCountOk;

  let reason = "ok";
  if (!checks.fresh) reason = "stale";
  else if (!checks.errorRatioOk) reason = "high_error_ratio";
  else if (!checks.domainCountOk) reason = "insufficient_domains";

  return {
    ok: shouldProceed,
    shouldProceed,
    reason,
    thresholds: {
      maxAgeMinutes: MAX_AGE_MINUTES,
      maxErrorRatioExclusive: MAX_ERROR_RATIO,
      minDomains: MIN_DOMAINS,
    },
    run,
    checks,
    metrics: {
      ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(2)) : null,
      errorRatio: Number.isFinite(errorRatio) ? Number(errorRatio.toFixed(4)) : null,
      domainCount,
      totalKeys,
      errorCount,
    },
  };
}

export function cli(): number {
  try {
    const summary = evaluateFreshnessGate();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary.shouldProceed ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, shouldProceed: false, reason: "gate_error", error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(cli());
}
