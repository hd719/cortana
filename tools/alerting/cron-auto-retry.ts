#!/usr/bin/env npx tsx

import fs from "fs";
import { spawnSync } from "child_process";

const JOBS_FILE = `${process.env.HOME}/.openclaw/cron/jobs.json`;
const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";

type JsonRecord = Record<string, unknown>;

type RetryResult = {
  id: string;
  name: string;
  previousFailures: number;
  retried: boolean;
  success: boolean;
  retryExitCode: number | null;
  stdout?: string;
  stderr?: string;
  logWritten: boolean;
  logError?: string;
};

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const toInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
};

const sqlLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function logEvent(result: RetryResult): { ok: boolean; error?: string } {
  const severity = result.success ? "info" : "warning";
  const statusWord = result.success ? "succeeded" : "failed";
  const message = `Cron auto-retry ${statusWord}: ${result.name} (${result.id})`;
  const metadata = {
    jobId: result.id,
    jobName: result.name,
    previousFailures: result.previousFailures,
    retryExitCode: result.retryExitCode,
  };

  const sql = [
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata)",
    `VALUES (${sqlLiteral("cron_auto_retry")}, ${sqlLiteral("heartbeat")}, ${sqlLiteral(severity)}, ${sqlLiteral(message)}, ${sqlLiteral(JSON.stringify(metadata))}::jsonb);`,
  ].join(" ");

  const run = spawnSync(PSQL_BIN, ["cortana", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH ?? ""}`,
      PGHOST: process.env.PGHOST ?? "localhost",
      PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd",
    },
  });

  if (run.status === 0) return { ok: true };
  const error = (run.stderr || run.stdout || "psql failed").trim();
  return { ok: false, error };
}

function main(): number {
  const raw = fs.readFileSync(JOBS_FILE, "utf8");
  const parsed = JSON.parse(raw) as JsonRecord;
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];

  const failedJobs: Array<{ id: string; name: string; previousFailures: number }> = [];

  for (const job of jobs) {
    if (!isRecord(job)) continue;
    const id = typeof job.id === "string" ? job.id : "";
    if (!id) continue;

    const name = typeof job.name === "string" ? job.name : id;
    const state = isRecord(job.state) ? job.state : {};

    const consecutiveFailures =
      toInt(state.consecutiveFailures) ??
      toInt(state.consecutiveErrors) ??
      0;

    if (consecutiveFailures >= 1) {
      failedJobs.push({ id, name, previousFailures: consecutiveFailures });
    }
  }

  const results: RetryResult[] = [];

  for (const job of failedJobs) {
    const run = spawnSync("openclaw", ["cron", "run", job.id], {
      encoding: "utf8",
      env: process.env,
    });

    const success = run.status === 0;
    const result: RetryResult = {
      id: job.id,
      name: job.name,
      previousFailures: job.previousFailures,
      retried: true,
      success,
      retryExitCode: run.status,
      stdout: run.stdout?.trim() || undefined,
      stderr: run.stderr?.trim() || undefined,
      logWritten: false,
    };

    const log = logEvent(result);
    result.logWritten = log.ok;
    if (!log.ok) result.logError = log.error;

    results.push(result);
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    jobsScanned: jobs.length,
    failedJobsFound: failedJobs.length,
    retried: results.length,
    succeeded: results.filter((r) => r.success).length,
    failedAgain: results.filter((r) => !r.success).length,
    results,
  };

  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return results.some((r) => !r.success) ? 1 : 0;
}

try {
  process.exit(main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
