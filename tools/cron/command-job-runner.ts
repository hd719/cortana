#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCommandJobSpec, type CommandJobSpec } from "./control-plane.js";
import { runPsql, withPostgresPath } from "../lib/db.js";

type CronJob = Record<string, unknown>;
type CronConfig = { jobs?: CronJob[] };
type Args = {
  jobId: string;
  jobsFile: string;
  alert: boolean;
};

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_JOBS_FILE = path.join(DEFAULT_REPO_ROOT, "config", "cron", "jobs.json");
const MAX_CAPTURE_CHARS = 6000;
const TELEGRAM_GUARD = path.join(DEFAULT_REPO_ROOT, "tools", "notifications", "telegram-delivery-guard.sh");

function parseArgs(argv: string[]): Args {
  let jobId = "";
  let jobsFile = process.env.CORTANA_CRON_JOBS_FILE ?? DEFAULT_JOBS_FILE;
  let alert = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--job-id" && argv[i + 1]) jobId = argv[++i];
    else if (arg === "--jobs-file" && argv[i + 1]) jobsFile = path.resolve(argv[++i]);
    else if (arg === "--alert") alert = true;
    else if (arg === "--no-alert") alert = false;
  }

  if (!jobId) throw new Error("missing required --job-id");
  return { jobId, jobsFile, alert };
}

function truncate(value: string, max = MAX_CAPTURE_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

export function redactOutput(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s'"]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]");
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function loadSpec(jobsFile: string, jobId: string): { job: CronJob; spec: CommandJobSpec } {
  const config = JSON.parse(fs.readFileSync(jobsFile, "utf8")) as CronConfig;
  const job = (Array.isArray(config.jobs) ? config.jobs : []).find((candidate) => String(candidate.id ?? "") === jobId);
  if (!job) throw new Error(`command job not found: ${jobId}`);
  const spec = getCommandJobSpec(job);
  if (!spec) throw new Error(`job does not define metadata.commandJobSpec or payload.kind=command: ${jobId}`);
  return { job, spec };
}

function writeEvent(type: string, severity: string, message: string, metadata: Record<string, unknown>): void {
  const sql = `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      ${sqlLiteral(type)},
      'command-job-runner',
      ${sqlLiteral(severity)},
      ${sqlLiteral(message)},
      ${sqlLiteral(JSON.stringify(metadata))}::jsonb
    );
  `;
  const result = runPsql(sql, { env: withPostgresPath(process.env), stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) {
    process.stderr.write(`[command-job-runner] event logging skipped: ${(result.stderr ?? "").trim()}\n`);
  }
}

function sendAlert(message: string, spec: CommandJobSpec): void {
  const alertType = spec.alertType || "cron_command_actionable";
  const dedupeKey = `${alertType}:${spec.id}`;
  const severity = spec.severity || "P2";
  const system = spec.system || "System";
  const actionNeeded = spec.actionNeeded || "soon";
  const proc = spawnSync(
    TELEGRAM_GUARD,
    [message, "8171372724", "", alertType, dedupeKey, severity, spec.owner, system, actionNeeded, "cron-maintenance"],
    { encoding: "utf8" },
  );
  if ((proc.status ?? 1) !== 0) {
    throw new Error(`telegram guard failed: ${(proc.stderr || proc.stdout || "").trim()}`);
  }
}

export function runCommandJob(spec: CommandJobSpec, alert: boolean): number {
  const startedAt = Date.now();
  const proc = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    encoding: "utf8",
    timeout: spec.timeoutMs,
    env: withPostgresPath(process.env),
    maxBuffer: 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const status = proc.status ?? (proc.signal ? 124 : 1);
  const errorCode = proc.error && "code" in proc.error ? String((proc.error as NodeJS.ErrnoException).code ?? "") : "";
  const timedOut = errorCode === "ETIMEDOUT" || (proc.error && /timed out|ETIMEDOUT/i.test(proc.error.message));
  const stdout = redactOutput(truncate(proc.stdout ?? ""));
  const stderr = redactOutput(truncate(proc.stderr ?? ""));
  const stdoutTrimmed = stdout.trim();
  const quiet = status === 0 && (stdoutTrimmed === spec.quietSuccess || (spec.allowEmptySuccess && stdoutTrimmed === ""));
  const metadata = {
    jobId: spec.id,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    status,
    signal: proc.signal ?? null,
    durationMs,
    timedOut: Boolean(timedOut),
    stdout,
    stderr,
  };

  if (quiet) {
    writeEvent("cron.command.success", "info", `Command cron succeeded quietly: ${spec.id}`, metadata);
    process.stdout.write("NO_REPLY\n");
    return 0;
  }

  const reason = timedOut ? `timed out after ${spec.timeoutMs}ms` : status === 0 ? "produced actionable output" : `exited ${status}`;
  const body = stdoutTrimmed || stderr.trim() || "No output captured.";
  const message = `Command cron ${spec.id} ${reason}\n${body}`.slice(0, 3500);
  writeEvent(timedOut ? "cron.command.timeout" : status === 0 ? "cron.command.actionable" : "cron.command.error", status === 0 ? "warning" : "critical", message, metadata);

  if (alert) sendAlert(message, spec);

  process.stdout.write(`${message}\n`);
  return status === 0 ? 0 : status;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { spec } = loadSpec(args.jobsFile, args.jobId);
  process.exit(runCommandJob(spec, args.alert));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
