#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { computeAndStoreScorecard } from "./autonomy_scorecard.js";
import { PSQL_BIN, resolveHomePath, resolveRepoPath } from "../tools/lib/paths.js";
import { readJsonFile } from "../tools/lib/json-file.js";

const JOBS_FILE = resolveHomePath(".openclaw/cron/jobs.json");
const HEARTBEAT_STATE_FILE = resolveHomePath("clawd/memory/heartbeat-state.json");
const HEARTBEAT_VALIDATOR = resolveHomePath("clawd/tools/heartbeat/validate-heartbeat-state.sh");
const REMEDIATION_STATE_FILE = resolveHomePath("clawd/proprioception/state/heartbeat-remediation.json");
const CRON_DELIVERY_CHECK = resolveRepoPath("tools/alerting/check-cron-delivery.sh");

const REMEDIATION_COOLDOWN_SEC = 30 * 60;
const MAX_REMEDIATIONS_PER_DAY = 3;
const STALE_RUNNING_FALLBACK_MS = 45 * 60 * 1000;
const HEARTBEAT_STATE_STALE_SEC = 8 * 60 * 60;

const HEARTBEAT_DEFAULT_STATE = {
  version: 2,
  lastChecks: {},
  lastRemediationAt: 0,
  subagentWatchdog: { lastRun: 0, lastLogged: {} },
};

type HeartbeatState = typeof HEARTBEAT_DEFAULT_STATE & {
  lastChecks: Record<string, { lastChecked: number }>;
  subagentWatchdog: { lastRun: number; lastLogged: Record<string, number> };
};

type ToolHealthRow = {
  tool_name: string;
  status: string;
  response_ms: number;
  error: string | null;
  self_healed: boolean;
};

type CronHealthRow = {
  cron_name: string;
  status: string;
  consecutive_failures: number;
  run_duration_sec: number;
  metadata: Record<string, unknown>;
};

type EventRow = {
  event_type: string;
  source: string;
  severity: string;
  message: string;
  metadata?: Record<string, unknown>;
};

function atomicWriteJsonWithBackup(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const backup = `${filePath}.bak`;
  const payload = JSON.stringify(data, null, 2) + "\n";

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backup);
  } else if (fs.existsSync(backup)) {
    fs.unlinkSync(backup);
  }

  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function validateHeartbeatState(data: unknown, now: number): HeartbeatState {
  const clean: HeartbeatState = {
    version: HEARTBEAT_DEFAULT_STATE.version,
    lastChecks: {},
    lastRemediationAt: now,
    subagentWatchdog: { lastRun: 0, lastLogged: {} },
  };

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const dict = data as Record<string, unknown>;
    clean.version = Number(dict.version ?? HEARTBEAT_DEFAULT_STATE.version);

    const lastChecks = dict.lastChecks;
    if (lastChecks && typeof lastChecks === "object" && !Array.isArray(lastChecks)) {
      const normalized: Record<string, { lastChecked: number }> = {};
      for (const [key, value] of Object.entries(lastChecks as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const v = value as Record<string, unknown>;
          normalized[key] = { lastChecked: Number(v.lastChecked ?? 0) };
        } else {
          normalized[key] = { lastChecked: Number(value ?? 0) };
        }
      }
      clean.lastChecks = normalized;
    }

    const sub = dict.subagentWatchdog;
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      const s = sub as Record<string, unknown>;
      const lastLogged = s.lastLogged;
      clean.subagentWatchdog = {
        lastRun: Number(s.lastRun ?? 0),
        lastLogged: lastLogged && typeof lastLogged === "object" && !Array.isArray(lastLogged)
          ? (lastLogged as Record<string, number>)
          : {},
      };
    }
  }

  clean.lastRemediationAt = now;
  return clean;
}

function loadHeartbeatState(now: number): [HeartbeatState, boolean, string] {
  if (!fs.existsSync(HEARTBEAT_STATE_FILE)) {
    return [validateHeartbeatState({}, now), true, "created_missing_state_file"];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf8"));
    const normalized = validateHeartbeatState(raw, now);
    const stale = (Date.now() / 1000 - fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs / 1000) > HEARTBEAT_STATE_STALE_SEC;
    return [normalized, true, stale ? "refreshed_state_file_stale" : "state_file_verified"];
  } catch {
    return [validateHeartbeatState({}, now), true, "repaired_corrupt_state_file"];
  }
}

function runCmd(cmd: string, timeout: number): { ok: boolean; duration_ms: number; error: string | null } {
  const start = Date.now();
  const proc = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    timeout: timeout * 1000,
  });
  const durationMs = Date.now() - start;
  const ok = proc.status === 0;

  let output = (proc.stderr || "").trim();
  if (!output && !ok) {
    output = (proc.stdout || "").trim();
  }

  if (!output && proc.error) {
    const err = proc.error as NodeJS.ErrnoException;
    if (err.code === "ETIMEDOUT") {
      output = "timeout";
    } else {
      output = err.message || "error";
    }
  }

  return { ok, duration_ms: durationMs, error: output ? output.slice(0, 500) : null };
}

function sqlEscape(val: string): string {
  return val ? val.replace(/'/g, "''") : "";
}

function runHeartbeatStateValidation(): EventRow[] {
  if (!fs.existsSync(HEARTBEAT_VALIDATOR)) {
    return [
      {
        event_type: "heartbeat_state_validation",
        source: "proprioception",
        severity: "warning",
        message: "Heartbeat state validator missing",
        metadata: { path: HEARTBEAT_VALIDATOR },
      },
    ];
  }

  const proc = spawnSync(HEARTBEAT_VALIDATOR, { encoding: "utf8" });
  const stdout = (proc.stdout || "").trim();
  let metadata: Record<string, unknown> = {};
  if (stdout) {
    try {
      const last = stdout.split(/\r?\n/).slice(-1)[0] ?? "";
      metadata = JSON.parse(last);
    } catch {
      metadata = { raw: stdout.slice(0, 500) };
    }
  }

  if (proc.status !== 0) {
    return [
      {
        event_type: "heartbeat_state_validation",
        source: "proprioception",
        severity: "warning",
        message: "Heartbeat state validation failed",
        metadata: { stderr: (proc.stderr || "").slice(0, 500), ...metadata },
      },
    ];
  }

  return [
    {
      event_type: "heartbeat_state_validation",
      source: "proprioception",
      severity: "info",
      message: "Heartbeat state validation completed",
      metadata,
    },
  ];
}

function collectToolHealth(): ToolHealthRow[] {
  const results: ToolHealthRow[] = [];

  const pg = runCmd(`${PSQL_BIN} cortana -c 'SELECT 1'`, 10);
  results.push({
    tool_name: "postgres",
    status: pg.ok ? "up" : "down",
    response_ms: pg.duration_ms,
    error: pg.error,
    self_healed: false,
  });

  const whoop = runCmd("curl -s --max-time 10 http://localhost:3033/whoop/data > /dev/null", 12);
  results.push({
    tool_name: "whoop",
    status: whoop.ok ? "up" : "down",
    response_ms: whoop.duration_ms,
    error: whoop.error,
    self_healed: false,
  });

  const tonal = runCmd("curl -s --max-time 10 http://localhost:3033/tonal/health | head -c 200", 12);
  results.push({
    tool_name: "tonal",
    status: tonal.ok ? "up" : "down",
    response_ms: tonal.duration_ms,
    error: tonal.error,
    self_healed: false,
  });

  const gog = runCmd("gog --account hameldesai3@gmail.com gmail search 'newer_than:1d' --max 1 > /dev/null", 15);
  results.push({
    tool_name: "gog",
    status: gog.ok ? "up" : "down",
    response_ms: gog.duration_ms,
    error: gog.error,
    self_healed: false,
  });

  const wttr = runCmd("curl -s --max-time 5 'https://wttr.in/?format=3' > /dev/null", 7);
  if (wttr.ok) {
    results.push({
      tool_name: "weather",
      status: "up",
      response_ms: wttr.duration_ms,
      error: null,
      self_healed: false,
    });
  } else {
    const fallback = runCmd(
      "curl -s --max-time 5 'https://api.open-meteo.com/v1/forecast?latitude=40.63&longitude=-74.49&current_weather=true&temperature_unit=fahrenheit' > /dev/null",
      7
    );
    results.push({
      tool_name: "weather",
      status: fallback.ok ? "up" : "down",
      response_ms: fallback.duration_ms,
      error: fallback.ok ? wttr.error : fallback.error,
      self_healed: fallback.ok,
    });
  }

  const cronDelivery = runCmd(`${CRON_DELIVERY_CHECK}`, 20);
  results.push({
    tool_name: "cron_delivery",
    status: cronDelivery.ok ? "up" : "down",
    response_ms: cronDelivery.duration_ms,
    error: cronDelivery.error,
    self_healed: false,
  });

  return results;
}

function loadJobs(): Array<Record<string, unknown>> {
  const payload = readJsonFile<{ jobs?: Array<Record<string, unknown>> }>(JOBS_FILE);
  if (!payload || !Array.isArray(payload.jobs)) return [];
  return payload.jobs;
}

function estimateIntervalMs(job: Record<string, unknown>, state: Record<string, unknown>, sched: Record<string, unknown>): number {
  if (sched.kind === "every") {
    return Number(sched.everyMs || 0);
  }
  if (sched.kind === "cron") {
    const nextRun = (state.nextRunAtMs as number | undefined) || 0;
    const lastRun = (state.lastRunAtMs as number | undefined) || (state.lastRunAt as number | undefined) || 0;
    if (nextRun && lastRun) {
      return Math.max(nextRun - lastRun, 0);
    }
    return 3600000;
  }
  return 0;
}

function collectCronHealth(jobs: Array<Record<string, unknown>>, nowMs: number): CronHealthRow[] {
  const results: CronHealthRow[] = [];

  for (const job of jobs) {
    if (!job.enabled) continue;
    const state = (job.state as Record<string, unknown>) || {};
    const sched = (job.schedule as Record<string, unknown>) || {};
    const lastRun = (state.lastRunAtMs as number | undefined) || (state.lastRunAt as number | undefined);
    const lastStatus = (state.lastStatus as string | undefined) || (state.lastRunStatus as string | undefined);
    const durationMs = state.lastDurationMs as number | undefined;
    const consecutiveErrors = Number(state.consecutiveErrors || 0);

    let status = "ok";
    const intervalMs = estimateIntervalMs(job, state, sched);

    if (!lastRun) {
      if (sched.kind === "at") {
        const atIso = sched.at as string | undefined;
        const nextRun = state.nextRunAtMs as number | undefined;
        if (nextRun && Number(nextRun) > nowMs) {
          status = "ok";
        } else if (atIso) {
          const parsed = new Date(atIso.replace("Z", "+00:00"));
          const atEpochMs = Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
          status = atEpochMs && atEpochMs > nowMs ? "ok" : "missed";
        } else {
          status = "missed";
        }
      } else {
        status = "missed";
      }
    } else if (lastStatus && !["ok", "skipped"].includes(lastStatus)) {
      status = "failed";
    } else if (intervalMs > 0 && (nowMs - Number(lastRun)) > intervalMs * 2) {
      status = "missed";
    }

    results.push({
      cron_name: (job.name as string) ?? "unknown",
      status,
      consecutive_failures: consecutiveErrors,
      run_duration_sec: (durationMs ?? 0) / 1000,
      metadata: {
        id: job.id,
        last_run_ms: lastRun,
        last_status: lastStatus,
        interval_ms: intervalMs,
      },
    });
  }

  return results;
}

function isHeartbeatJob(job: Record<string, unknown>): boolean {
  const name = String(job.name ?? "").toLowerCase();
  const message = String((job.payload as Record<string, unknown> | undefined)?.message ?? "").toLowerCase();
  return name.includes("heartbeat") || message.includes("heartbeat_ok") || message.includes("read heartbeat.md");
}

function loadRemediationState(): Record<string, unknown> {
  const data = readJsonFile<Record<string, unknown>>(REMEDIATION_STATE_FILE);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const jobs = (data as any).jobs;
    if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
      return data as Record<string, unknown>;
    }
  }
  return { jobs: {} };
}

function saveRemediationState(state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(REMEDIATION_STATE_FILE), { recursive: true });
  fs.writeFileSync(REMEDIATION_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function ensureHeartbeatStateFile(now: number): [boolean, string] {
  const [data, ensured, action] = loadHeartbeatState(now);
  atomicWriteJsonWithBackup(HEARTBEAT_STATE_FILE, data as unknown as Record<string, unknown>);
  return [ensured, action];
}

function remediateHeartbeatMisses(
  jobs: Array<Record<string, unknown>>,
  cronRows: CronHealthRow[],
  nowMs: number,
  dryRun = false
): [EventRow[], boolean] {
  const rowById = new Map<string | number, CronHealthRow>();
  for (const row of cronRows) {
    const id = row.metadata?.id as string | number | undefined;
    if (id !== undefined) rowById.set(id, row);
  }

  const hbJobs = jobs.filter((job) => job.enabled && isHeartbeatJob(job));
  if (!hbJobs.length) return [[], false];

  const remState = loadRemediationState();
  const remJobs = (remState.jobs as Record<string, any>) || {};
  const nowSec = Math.floor(nowMs / 1000);
  let changedJobsFile = false;
  const events: EventRow[] = [];

  for (const job of hbJobs) {
    const jobId = job.id as string | number | undefined;
    if (!jobId) continue;

    const cronRow = rowById.get(jobId);
    const status = cronRow?.status ?? "ok";
    const consecutive = cronRow?.consecutive_failures ?? 0;

    const state = (job.state as Record<string, unknown>) || {};
    job.state = state;

    const intervalMs = estimateIntervalMs(job, state, (job.schedule as Record<string, unknown>) || {});
    const runningAt = state.runningAtMs as number | undefined;
    const staleRunning = Boolean(runningAt && (nowMs - Number(runningAt)) > Math.max(intervalMs * 2, STALE_RUNNING_FALLBACK_MS));

    const missDetected = ["missed", "failed"].includes(status) || consecutive >= 2 || staleRunning;
    if (!missDetected) continue;

    const hist = remJobs[jobId] ?? { attempts: [], last_attempt: 0 };
    const lastAttempt = Number(hist.last_attempt ?? 0);
    const recentAttempts = (hist.attempts as number[] ?? []).filter((a) => nowSec - Number(a) <= 86400);
    hist.attempts = recentAttempts;
    remJobs[jobId] = hist;

    events.push({
      event_type: "heartbeat_miss_detected",
      source: "proprioception",
      severity: "warning",
      message: `Heartbeat miss detected for job '${job.name ?? "unknown"}'`,
      metadata: {
        job_id: jobId,
        job_name: job.name,
        status,
        consecutive_failures: consecutive,
        stale_running: staleRunning,
        interval_ms: intervalMs,
      },
    });

    const cooldownActive = (nowSec - lastAttempt) < REMEDIATION_COOLDOWN_SEC;
    const tooManyAttempts = recentAttempts.length >= MAX_REMEDIATIONS_PER_DAY;

    if (cooldownActive || tooManyAttempts) {
      events.push({
        event_type: "heartbeat_auto_remediation",
        source: "proprioception",
        severity: "info",
        message: "Skipped remediation due to guardrail",
        metadata: {
          job_id: jobId,
          job_name: job.name,
          reason: cooldownActive ? "cooldown" : "max_attempts_24h",
          last_attempt: lastAttempt,
          attempts_24h: recentAttempts.length,
        },
      });
      continue;
    }

    const actions: string[] = [];
    if (staleRunning) {
      delete state.runningAtMs;
      actions.push("cleared_stale_runningAtMs");
      changedJobsFile = true;
    }

    state.nextRunAtMs = nowMs + 60_000;
    actions.push("scheduled_next_run_in_60s");
    changedJobsFile = true;

    const [ensured, stateAction] = ensureHeartbeatStateFile(nowSec);
    if (ensured) {
      actions.push(stateAction);
    }

    hist.last_attempt = nowSec;
    hist.attempts = [...recentAttempts, nowSec];

    events.push({
      event_type: "heartbeat_auto_remediation",
      source: "proprioception",
      severity: "info",
      message: `Applied heartbeat auto-remediation for job '${job.name ?? "unknown"}'`,
      metadata: {
        job_id: jobId,
        job_name: job.name,
        actions,
        attempts_24h: hist.attempts.length,
      },
    });
  }

  const stateFileHist = remJobs.__state_file__ ?? { attempts: [], last_attempt: 0 };
  const stateFileRecent = (stateFileHist.attempts as number[] ?? []).filter((a) => nowSec - Number(a) <= 86400);
  stateFileHist.attempts = stateFileRecent;
  const stateFileLast = Number(stateFileHist.last_attempt ?? 0);
  remJobs.__state_file__ = stateFileHist;

  let stateIssue = false;
  let stateReason: string | null = null;
  if (!fs.existsSync(HEARTBEAT_STATE_FILE)) {
    stateIssue = true;
    stateReason = "missing";
  } else {
    try {
      JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf8"));
      if ((Date.now() / 1000 - fs.statSync(HEARTBEAT_STATE_FILE).mtimeMs / 1000) > HEARTBEAT_STATE_STALE_SEC) {
        stateIssue = true;
        stateReason = "stale";
      }
    } catch {
      stateIssue = true;
      stateReason = "corrupt";
    }
  }

  if (stateIssue) {
    events.push({
      event_type: "heartbeat_miss_detected",
      source: "proprioception",
      severity: "warning",
      message: "Heartbeat state signal indicates a miss",
      metadata: { reason: stateReason, path: HEARTBEAT_STATE_FILE },
    });

    const stateCooldown = (nowSec - stateFileLast) < REMEDIATION_COOLDOWN_SEC;
    const stateTooMany = stateFileRecent.length >= MAX_REMEDIATIONS_PER_DAY;
    if (stateCooldown || stateTooMany) {
      events.push({
        event_type: "heartbeat_auto_remediation",
        source: "proprioception",
        severity: "info",
        message: "Skipped heartbeat state remediation due to guardrail",
        metadata: {
          reason: stateCooldown ? "cooldown" : "max_attempts_24h",
          attempts_24h: stateFileRecent.length,
        },
      });
    } else {
      const [ensured, stateAction] = ensureHeartbeatStateFile(nowSec);
      stateFileHist.last_attempt = nowSec;
      stateFileHist.attempts = [...stateFileRecent, nowSec];
      events.push({
        event_type: "heartbeat_auto_remediation",
        source: "proprioception",
        severity: "info",
        message: "Applied heartbeat state auto-remediation",
        metadata: { action: stateAction, ensured },
      });
    }
  }

  if (!dryRun && changedJobsFile) {
    const content = fs.existsSync(JOBS_FILE)
      ? JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"))
      : { version: 1, jobs: [] };
    content.jobs = jobs;
    fs.writeFileSync(JOBS_FILE, JSON.stringify(content, null, 2) + "\n");
  }

  if (!dryRun) {
    remState.jobs = remJobs;
    saveRemediationState(remState);
  }

  return [events, changedJobsFile];
}

function collectMemoryHealthSummary(): Record<string, unknown> {
  const query =
    "WITH m AS (" +
    " SELECT " +
    "  (SELECT COUNT(*) FROM cortana_memory_episodic WHERE active = TRUE) AS episodic_total," +
    "  (SELECT COUNT(*) FROM cortana_memory_semantic WHERE active = TRUE) AS semantic_total," +
    "  (SELECT COUNT(*) FROM cortana_memory_procedural WHERE deprecated = FALSE) AS procedural_total," +
    "  (SELECT COUNT(*) FROM cortana_memory_archive) AS archived_total," +
    "  (SELECT status FROM cortana_memory_ingest_runs ORDER BY id DESC LIMIT 1) AS last_run_status," +
    "  (SELECT COALESCE(MAX(finished_at), MAX(started_at)) FROM cortana_memory_ingest_runs) AS last_ingest_at" +
    ") SELECT row_to_json(m)::text FROM m;";

  try {
    const out = spawnSync(PSQL_BIN, ["cortana", "-At", "-c", query], { encoding: "utf8", timeout: 10000 });
    if (out.status !== 0 || !out.stdout?.trim()) return {};
    return JSON.parse(out.stdout.trim());
  } catch {
    return {};
  }
}

function buildSql(toolRows: ToolHealthRow[], cronRows: CronHealthRow[], events: EventRow[]): string {
  const stmts: string[] = [];

  for (const row of toolRows) {
    const errVal = row.error ? `'${sqlEscape(row.error)}'` : "NULL";
    stmts.push(
      "INSERT INTO cortana_tool_health (tool_name, status, response_ms, error, self_healed) " +
        `VALUES ('${sqlEscape(row.tool_name)}', '${row.status}', ${row.response_ms}, ${errVal}, ${String(row.self_healed).toLowerCase()});`
    );
  }

  for (const row of cronRows) {
    const mdJson = JSON.stringify(row.metadata ?? {});
    stmts.push(
      "INSERT INTO cortana_cron_health (cron_name, status, consecutive_failures, run_duration_sec, metadata) " +
        `VALUES ('${sqlEscape(row.cron_name)}', '${row.status}', ${row.consecutive_failures}, ${row.run_duration_sec}, '${sqlEscape(mdJson)}');`
    );
  }

  for (const event of events) {
    const mdJson = JSON.stringify(event.metadata ?? {});
    stmts.push(
      "INSERT INTO cortana_events (event_type, source, severity, message, metadata) " +
        `VALUES ('${sqlEscape(event.event_type)}', '${sqlEscape(event.source)}', '${sqlEscape(event.severity)}', '${sqlEscape(event.message)}', '${sqlEscape(mdJson)}'::jsonb);`
    );
  }

  return stmts.join("\n");
}

type Args = { dryRun: boolean };

function parseArgs(argv: string[]): Args {
  return { dryRun: argv.includes("--dry-run") };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const nowMs = Date.now();
  const jobs = loadJobs();
  const validationEvents = runHeartbeatStateValidation();
  const toolRows = collectToolHealth();
  const cronRows = collectCronHealth(jobs, nowMs);
  const [events, _] = remediateHeartbeatMisses(jobs, cronRows, nowMs, args.dryRun);
  const allEvents = [...validationEvents, ...events];

  const memoryHealth = collectMemoryHealthSummary();
  if (Object.keys(memoryHealth).length > 0) {
    allEvents.push({
      event_type: "memory_health",
      source: "proprioception",
      severity: "info",
      message: "Unified memory health snapshot",
      metadata: memoryHealth,
    });
  }

  let autonomySummary: Record<string, unknown> | null = null;
  try {
    autonomySummary = computeAndStoreScorecard(7, args.dryRun) as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    allEvents.push({
      event_type: "autonomy_scorecard_error",
      source: "proprioception",
      severity: "warning",
      message: "Autonomy scorecard computation failed",
      metadata: { error: msg.slice(0, 500) },
    });
  }

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          tool_rows: toolRows.length,
          cron_rows: cronRows.length,
          events: allEvents,
          autonomy_scorecard: autonomySummary,
        },
        null,
        2
      )
    );
    return;
  }

  const sql = buildSql(toolRows, cronRows, allEvents);
  if (!sql.trim()) return;

  const env = { ...process.env };
  if (!env.PGHOST) env.PGHOST = "localhost";
  if (!env.PGUSER) env.PGUSER = process.env.USER ?? "hd";

  const result = spawnSync(PSQL_BIN, ["cortana", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`psql insert failed: ${result.stderr}\nSQL:\n${sql}`);
  }
}

try {
  main();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(msg);
  process.exit(1);
}
