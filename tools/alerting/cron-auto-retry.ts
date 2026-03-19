#!/usr/bin/env npx tsx

import fs from "fs";
import { spawnSync } from "child_process";
import { classifyReliabilityLane, loadAutonomyConfig, type ReliabilityLane } from "../monitoring/autonomy-lanes.ts";

const JOBS_FILE = `${process.env.HOME}/.openclaw/cron/jobs.json`;
const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const SOURCE = "heartbeat";
const DEFAULT_CRITICAL_JOB_NAMES = new Set([
  "☀️ Morning brief (Hamel)",
  "📈 Stock Market Brief (daily)",
  "🏋️ Fitness Morning Brief (Hamel)",
  "📅 Calendar reminders → Telegram (ALL calendars)",
  "⏰ Apple Reminders alerts → Telegram (Monitor)",
  "🌙 Weekend Pre-Bedtime (9:30pm Fri/Sat)",
]);
const TRANSIENT_ERROR_PATTERNS = [
  /gatewaydrainingerror/i,
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /temporar(y|ily) unavailable/i,
  /overloaded?/i,
  /rate limit/i,
  /quota exceeded/i,
  /429/i,
  /5\d\d/i,
  /econnreset/i,
  /enotfound/i,
  /network/i,
  /fetch failed/i,
  /socket/i,
];
const LOCAL_SCRIPT_PATTERNS = [
  /syntaxerror/i,
  /module not found/i,
  /cannot find module/i,
  /enoent/i,
  /permission denied/i,
  /traceback/i,
  /typeerror/i,
  /referenceerror/i,
  /not executable/i,
];
const AUTH_PATTERNS = [
  /401/i,
  /403/i,
  /unauthoriz/i,
  /invalid[_ -]?api[_ -]?key/i,
  /incorrect[_ -]?api[_ -]?key/i,
  /authentication/i,
  /expired token/i,
  /token expired/i,
  /invalid[_ -]?token/i,
  /reauth/i,
  /login required/i,
  /session expired/i,
];

type JsonRecord = Record<string, unknown>;
type FailureKind = "transient" | "auth" | "local_script" | "unknown";

type RetryResult = {
  id: string;
  name: string;
  lane: ReliabilityLane;
  previousFailures: number;
  failureKind: FailureKind;
  failureDetail?: string;
  followUp?: string | null;
  retried: boolean;
  skippedReason?: string;
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

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  return {
    criticalOnly: args.has("--critical-only"),
    json: args.has("--json"),
  };
}

function criticalNames(): Set<string> {
  const raw = String(process.env.CRITICAL_CRON_NAMES ?? "").trim();
  if (raw) {
    const names = raw.split(",").map((item) => item.trim()).filter(Boolean);
    return names.length ? new Set(names) : DEFAULT_CRITICAL_JOB_NAMES;
  }

  const config = loadAutonomyConfig();
  return new Set([...DEFAULT_CRITICAL_JOB_NAMES, ...config.familyCriticalCronNames]);
}

function failureText(state: JsonRecord): string {
  const fields = [state.lastError, state.lastErrorMessage, state.lastRunError, state.lastOutput, state.lastStatusDetail]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return fields.join(" | ");
}

function classifyFailure(detail: string): FailureKind {
  if (!detail) return "unknown";
  if (AUTH_PATTERNS.some((pattern) => pattern.test(detail))) return "auth";
  if (LOCAL_SCRIPT_PATTERNS.some((pattern) => pattern.test(detail))) return "local_script";
  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) return "transient";
  return "unknown";
}

function followUpFor(result: Pick<RetryResult, "failureKind" | "success">): string | null {
  if (!result.success) return "escalate_to_human";
  if (result.failureKind === "transient") return "log_event_and_monitor_for_repeat";
  return null;
}

function logEvent(result: RetryResult): { ok: boolean; error?: string } {
  const severity = result.success ? "info" : "warning";
  const statusWord = result.retried ? (result.success ? "succeeded" : "failed") : "skipped";
  const message = `Cron auto-retry ${statusWord}: ${result.name} (${result.id})`;
  const metadata = {
    jobId: result.id,
    jobName: result.name,
    lane: result.lane,
    previousFailures: result.previousFailures,
    retryExitCode: result.retryExitCode,
    failureKind: result.failureKind,
    failureDetail: result.failureDetail,
    skippedReason: result.skippedReason ?? null,
    followUp: result.followUp ?? null,
  };

  const sql = [
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata)",
    `VALUES (${sqlLiteral("cron_auto_retry")}, ${sqlLiteral(SOURCE)}, ${sqlLiteral(severity)}, ${sqlLiteral(message)}, ${sqlLiteral(JSON.stringify(metadata))}::jsonb);`,
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
  const args = parseArgs();
  const raw = fs.readFileSync(JOBS_FILE, "utf8");
  const parsed = JSON.parse(raw) as JsonRecord;
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const criticalJobNames = criticalNames();

  const candidates: Array<{ id: string; name: string; lane: ReliabilityLane; previousFailures: number; failureKind: FailureKind; failureDetail: string }> = [];

  for (const job of jobs) {
    if (!isRecord(job)) continue;
    const id = typeof job.id === "string" ? job.id : "";
    if (!id) continue;

    const name = typeof job.name === "string" ? job.name : id;
    if (args.criticalOnly && !criticalJobNames.has(name)) continue;

    const state = isRecord(job.state) ? job.state : {};
    const consecutiveFailures = toInt(state.consecutiveFailures) ?? toInt(state.consecutiveErrors) ?? 0;
    if (consecutiveFailures < 1) continue;

    const detail = failureText(state);
    const failureKind = classifyFailure(detail);
    const lane = classifyReliabilityLane(name);
    candidates.push({ id, name, lane, previousFailures: consecutiveFailures, failureKind, failureDetail: detail });
  }

  const results: RetryResult[] = [];

  for (const job of candidates) {
    if (job.previousFailures > 1) {
      const result: RetryResult = {
        id: job.id,
        name: job.name,
        lane: job.lane,
        previousFailures: job.previousFailures,
        failureKind: job.failureKind,
        failureDetail: job.failureDetail || undefined,
        retried: false,
        skippedReason: "repeated_failure_requires_escalation",
        success: false,
        retryExitCode: null,
        logWritten: false,
        followUp: "escalate_to_human",
      };
      const log = logEvent(result);
      result.logWritten = log.ok;
      if (!log.ok) result.logError = log.error;
      results.push(result);
      continue;
    }

    if (job.failureKind !== "transient") {
      const result: RetryResult = {
        id: job.id,
        name: job.name,
        lane: job.lane,
        previousFailures: job.previousFailures,
        failureKind: job.failureKind,
        failureDetail: job.failureDetail || undefined,
        retried: false,
        skippedReason: job.failureKind === "auth" ? "auth_failure_requires_specialized_recovery" : "non_transient_failure_requires_human_review",
        success: false,
        retryExitCode: null,
        logWritten: false,
        followUp: "escalate_to_human",
      };
      const log = logEvent(result);
      result.logWritten = log.ok;
      if (!log.ok) result.logError = log.error;
      results.push(result);
      continue;
    }

    const run = spawnSync("openclaw", ["cron", "run", job.id], {
      encoding: "utf8",
      env: process.env,
    });

    const success = run.status === 0;
    const result: RetryResult = {
      id: job.id,
      name: job.name,
      lane: job.lane,
      previousFailures: job.previousFailures,
      failureKind: job.failureKind,
      failureDetail: job.failureDetail || undefined,
      followUp: followUpFor({ failureKind: job.failureKind, success }),
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
    posture: loadAutonomyConfig().posture,
    jobsScanned: jobs.length,
    candidates: candidates.length,
    retried: results.filter((r) => r.retried).length,
    skipped: results.filter((r) => !r.retried).length,
    succeeded: results.filter((r) => r.retried && r.success).length,
    failedAgain: results.filter((r) => r.retried && !r.success).length,
    escalations: results.filter((r) => !r.success).length,
    familyCritical: {
      candidates: results.filter((r) => r.lane === "family_critical").length,
      escalations: results.filter((r) => r.lane === "family_critical" && !r.success).length,
      recovered: results.filter((r) => r.lane === "family_critical" && r.retried && r.success).length,
    },
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
