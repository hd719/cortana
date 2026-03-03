#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

type JsonRecord = Record<string, unknown>;

type JobState = {
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
};

type Job = {
  id?: string;
  name?: string;
  enabled?: boolean;
  state?: JobState;
};

type RecoveryState = {
  recovered: Record<string, number>;
};

const JOBS_FILE = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
const STATE_FILE = "/tmp/cron-gateway-drain-recovery.json";
const SOURCE = "cron-restart-recovery";
const WINDOW_MS = Number(process.env.GATEWAY_DRAIN_WINDOW_MS ?? 30 * 60 * 1000);
const MAX_PER_RUN = Number(process.env.GATEWAY_DRAIN_MAX_RETRIES ?? 4);
const TARGET_ERROR = "GatewayDrainingError";
const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const toInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
};

const sqlEscape = (value: string) => value.replace(/'/g, "''");

const readRecoveryState = (): RecoveryState => {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as RecoveryState;
    if (!parsed || typeof parsed !== "object") return { recovered: {} };
    if (!parsed.recovered || typeof parsed.recovered !== "object") return { recovered: {} };
    return parsed;
  } catch {
    return { recovered: {} };
  }
};

const writeRecoveryState = (state: RecoveryState): void => {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const logEvent = (severity: "info" | "warning", message: string, metadata: Record<string, unknown>) => {
  const sql = [
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata)",
    `VALUES ('cron_gateway_drain_recovery', '${SOURCE}', '${severity}', '${sqlEscape(message)}', '${sqlEscape(JSON.stringify(metadata))}'::jsonb);`,
  ].join(" ");

  spawnSync(PSQL_BIN, ["cortana", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH ?? ""}`,
      PGHOST: process.env.PGHOST ?? "localhost",
      PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd",
    },
    stdio: "ignore",
  });
};

function main(): number {
  const raw = fs.readFileSync(JOBS_FILE, "utf8");
  const parsed = JSON.parse(raw) as JsonRecord;
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs as Job[] : [];

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const recoveryState = readRecoveryState();

  const candidates: Array<{ id: string; name: string; failedRunAtMs: number; lastError: string }> = [];

  for (const job of jobs) {
    if (!isRecord(job)) continue;
    if (job.enabled === false) continue;

    const id = typeof job.id === "string" ? job.id : "";
    if (!id) continue;

    const state = isRecord(job.state) ? (job.state as JobState) : {};
    const failedRunAtMs = toInt(state.lastRunAtMs);
    if (!failedRunAtMs || failedRunAtMs < cutoff) continue;

    const lastStatus = String(state.lastStatus ?? "").toLowerCase();
    if (!["failed", "error", "timeout"].includes(lastStatus)) continue;

    const lastError = String(state.lastError ?? "");
    if (!lastError.includes(TARGET_ERROR)) continue;

    const recoveryKey = `${id}:${failedRunAtMs}`;
    if (recoveryState.recovered[recoveryKey]) continue;

    candidates.push({
      id,
      name: typeof job.name === "string" && job.name.trim() ? job.name : id,
      failedRunAtMs,
      lastError,
    });
  }

  if (candidates.length === 0) {
    process.stdout.write("NO_REPLY\n");
    return 0;
  }

  const selected = candidates.slice(0, Math.max(1, MAX_PER_RUN));

  for (const candidate of selected) {
    const recoveryKey = `${candidate.id}:${candidate.failedRunAtMs}`;
    const retry = spawnSync("openclaw", ["cron", "run", candidate.id], {
      encoding: "utf8",
      env: process.env,
    });

    const success = retry.status === 0;
    recoveryState.recovered[recoveryKey] = now;

    const metadata = {
      jobId: candidate.id,
      jobName: candidate.name,
      failedRunAtMs: candidate.failedRunAtMs,
      retryExitCode: retry.status,
      retryStdout: retry.stdout?.trim()?.slice(0, 1200) ?? null,
      retryStderr: retry.stderr?.trim()?.slice(0, 1200) ?? null,
      triggerError: TARGET_ERROR,
    };

    logEvent(
      success ? "info" : "warning",
      success
        ? `Recovered cron after GatewayDrainingError: ${candidate.name}`
        : `GatewayDrainingError recovery retry failed: ${candidate.name}`,
      metadata
    );
  }

  writeRecoveryState(recoveryState);
  process.stdout.write("NO_REPLY\n");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
