#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { evaluateHeartbeatHealth } from "../heartbeat/check-heartbeat-health.ts";
import { defaultHeartbeatStatePath, PSQL_BIN, resolveRuntimeStatePath } from "../lib/paths.js";
import { withPostgresPath } from "../lib/db.js";

type RuntimeJob = {
  id?: string;
  name?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
    everyMs?: number;
  };
  state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    lastRunStatus?: string;
    lastDurationMs?: number;
    nextRunAtMs?: number;
    consecutiveErrors?: number;
  };
};

type CronRunEntry = {
  ts?: number;
  runAtMs?: number;
  action?: string;
  status?: string;
  summary?: string;
  error?: string;
  durationMs?: number;
};

type HealthSnapshot = {
  errorCount: number;
  cronFailCount: number;
  warningCount: number;
  criticalCount: number;
};

type JobRunSnapshot = {
  job: RuntimeJob;
  latestEntry: CronRunEntry | null;
  latestFinished: CronRunEntry | null;
  lastRunAtMs: number;
  lastStatus: string;
  lastDurationMs: number;
  consecutiveErrors: number;
  inFlightToday: boolean;
  ranToday: boolean;
  scheduledToday: boolean;
  dueByNow: boolean;
};

type BuildDigestOptions = {
  now: Date;
  jobs: RuntimeJob[];
  selfJobId?: string;
  heartbeatStatus: "healthy" | "stale" | "invalid" | "missing";
  health: HealthSnapshot;
  latestEntriesByJobId: Record<string, CronRunEntry | null>;
  latestFinishedByJobId: Record<string, CronRunEntry | null>;
};

type FieldMatcher = {
  any: boolean;
  matches: (value: number) => boolean;
};

const DEFAULT_TZ = "America/New_York";
const MISSING_GRACE_MINUTES = 10;

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.trunc(numeric);
  }
  return 0;
}

function compactName(job: RuntimeJob): string {
  return String(job.name ?? job.id ?? "unknown");
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0.0s";
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function parseOffsetMs(tzOffset: string): number {
  const normalized = tzOffset.replace(/^GMT/i, "");
  if (!normalized || normalized === "Z") return 0;
  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(date);
  const tzName = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return parseOffsetMs(tzName);
}

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function startOfDayMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  return utcMidnight - getTimeZoneOffsetMs(new Date(utcMidnight), timeZone);
}

function parseFieldToken(token: string, min: number, max: number): number[] {
  const trimmed = token.trim();
  if (!trimmed) return [];
  let step = 1;
  let base = trimmed;
  if (trimmed.includes("/")) {
    const pieces = trimmed.split("/");
    base = pieces[0] ?? "*";
    step = Number(pieces[1] ?? "1");
    if (!Number.isFinite(step) || step <= 0) return [];
  }
  const values: number[] = [];
  if (base === "*") {
    for (let value = min; value <= max; value += step) values.push(value);
    return values;
  }
  if (base.includes("-")) {
    const [startRaw, endRaw] = base.split("-");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    for (let value = start; value <= end; value += step) {
      if (value >= min && value <= max) values.push(value);
    }
    return values;
  }
  const value = Number(base);
  if (!Number.isFinite(value) || value < min || value > max) return [];
  return [value];
}

function parseCronField(field: string, min: number, max: number, normalize?: (value: number) => number): FieldMatcher {
  const trimmed = field.trim();
  if (trimmed === "*") {
    return { any: true, matches: () => true };
  }
  const values = new Set<number>();
  for (const token of trimmed.split(",")) {
    for (const rawValue of parseFieldToken(token, min, max)) {
      const normalized = normalize ? normalize(rawValue) : rawValue;
      if (normalized >= min && normalized <= max) values.add(normalized);
    }
  }
  return {
    any: false,
    matches: (value: number) => values.has(value),
  };
}

function cronWindow(expr: string, now: Date, timeZone: string): { scheduledToday: boolean; dueByNow: boolean } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { scheduledToday: false, dueByNow: false };
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  const minuteMatcher = parseCronField(minuteField, 0, 59);
  const hourMatcher = parseCronField(hourField, 0, 23);
  const domMatcher = parseCronField(domField, 1, 31);
  const monthMatcher = parseCronField(monthField, 1, 12);
  const dowMatcher = parseCronField(dowField, 0, 6, (value) => (value === 7 ? 0 : value));
  const parts = zonedParts(now, timeZone);

  if (!monthMatcher.matches(parts.month)) return { scheduledToday: false, dueByNow: false };

  const domMatches = domMatcher.matches(parts.day);
  const dowMatches = dowMatcher.matches(parts.weekday);
  const dayMatches = domMatcher.any && dowMatcher.any
    ? true
    : domMatcher.any
      ? dowMatches
      : dowMatcher.any
        ? domMatches
        : domMatches || dowMatches;

  if (!dayMatches) return { scheduledToday: false, dueByNow: false };

  let scheduledToday = false;
  let dueByNow = false;
  const currentMinuteOfDay = (parts.hour * 60) + parts.minute;
  const dueThreshold = currentMinuteOfDay - MISSING_GRACE_MINUTES;
  for (let hour = 0; hour <= 23; hour += 1) {
    if (!hourMatcher.matches(hour)) continue;
    for (let minute = 0; minute <= 59; minute += 1) {
      if (!minuteMatcher.matches(minute)) continue;
      scheduledToday = true;
      if (((hour * 60) + minute) <= dueThreshold) {
        dueByNow = true;
      }
    }
  }

  return { scheduledToday, dueByNow };
}

function scheduleWindow(job: RuntimeJob, now: Date): { scheduledToday: boolean; dueByNow: boolean } {
  const kind = String(job.schedule?.kind ?? "");
  const tz = String(job.schedule?.tz ?? DEFAULT_TZ);
  if (kind === "cron" && typeof job.schedule?.expr === "string") {
    return cronWindow(job.schedule.expr, now, tz);
  }
  return { scheduledToday: false, dueByNow: false };
}

function parseRunLine(line: string): CronRunEntry | null {
  try {
    const parsed = JSON.parse(line) as CronRunEntry;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readLatestRunEntries(runDir: string, jobId: string): { latestEntry: CronRunEntry | null; latestFinished: CronRunEntry | null } {
  const runPath = `${runDir}/${jobId}.jsonl`;
  try {
    const raw = fs.readFileSync(runPath, "utf8").trim();
    if (!raw) return { latestEntry: null, latestFinished: null };
    const lines = raw.split("\n");
    let latestEntry: CronRunEntry | null = null;
    let latestFinished: CronRunEntry | null = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parseRunLine(lines[index] ?? "");
      if (!entry) continue;
      if (!latestEntry) latestEntry = entry;
      if (!latestFinished && entry.action === "finished") latestFinished = entry;
      if (latestEntry && latestFinished) break;
    }
    return { latestEntry, latestFinished };
  } catch {
    return { latestEntry: null, latestFinished: null };
  }
}

function heartbeatLabel(status: "healthy" | "stale" | "invalid" | "missing"): string {
  if (status === "healthy") return "Heartbeat healthy now.";
  if (status === "stale") return "Heartbeat stale now.";
  if (status === "missing") return "Heartbeat state missing now.";
  return "Heartbeat state invalid now.";
}

function buildHealthLine(health: HealthSnapshot, heartbeatStatus: "healthy" | "stale" | "invalid" | "missing"): string {
  const base = `Health: ${health.errorCount} error events, ${health.cronFailCount} cron_fail today.`;
  const watchlist = health.criticalCount || health.warningCount
    ? ` Watchlist: ${health.criticalCount} critical + ${health.warningCount} warnings.`
    : "";
  return `${base}${watchlist} ${heartbeatLabel(heartbeatStatus)}`.trim();
}

function buildJobSnapshot(options: BuildDigestOptions, job: RuntimeJob): JobRunSnapshot {
  const jobId = String(job.id ?? "");
  const latestEntry = jobId ? (options.latestEntriesByJobId[jobId] ?? null) : null;
  const latestFinished = jobId ? (options.latestFinishedByJobId[jobId] ?? null) : null;
  const startOfDay = startOfDayMs(options.now, String(job.schedule?.tz ?? DEFAULT_TZ));
  const stateLastRunAtMs = parseNumber(job.state?.lastRunAtMs);
  const finishedRunAtMs = parseNumber(latestFinished?.runAtMs);
  const lastRunAtMs = Math.max(finishedRunAtMs, stateLastRunAtMs);
  const lastStatus = String(latestFinished?.status ?? job.state?.lastStatus ?? job.state?.lastRunStatus ?? "");
  const lastDurationMs = parseNumber(latestFinished?.durationMs ?? job.state?.lastDurationMs);
  const inFlightRunAtMs = parseNumber(latestEntry?.runAtMs);
  const inFlightToday = Boolean(
    latestEntry
      && latestEntry.action !== "finished"
      && inFlightRunAtMs >= startOfDay,
  );
  const ranToday = lastRunAtMs >= startOfDay || inFlightToday;
  const { scheduledToday, dueByNow } = scheduleWindow(job, options.now);

  return {
    job,
    latestEntry,
    latestFinished,
    lastRunAtMs,
    lastStatus,
    lastDurationMs,
    consecutiveErrors: parseNumber(job.state?.consecutiveErrors),
    inFlightToday,
    ranToday,
    scheduledToday,
    dueByNow,
  };
}

function buildDigest(options: BuildDigestOptions): string {
  const enabledJobs = options.jobs.filter((job) => job.enabled !== false);
  const snapshots = enabledJobs.map((job) => buildJobSnapshot(options, job));
  const ranToday = snapshots.filter((snapshot) => snapshot.ranToday);
  const failedToday = snapshots.filter((snapshot) =>
    snapshot.latestFinished
      && snapshot.lastRunAtMs >= startOfDayMs(options.now, String(snapshot.job.schedule?.tz ?? DEFAULT_TZ))
      && ["error", "failed"].includes(snapshot.lastStatus),
  );
  const runningNow = snapshots.filter((snapshot) => snapshot.inFlightToday);
  const missing = snapshots.filter((snapshot) => {
    const jobId = String(snapshot.job.id ?? "");
    if (jobId && jobId === options.selfJobId) return false;
    return snapshot.scheduledToday && snapshot.dueByNow && !snapshot.ranToday;
  });
  const notScheduledExamples = snapshots
    .filter((snapshot) => !snapshot.scheduledToday)
    .map((snapshot) => compactName(snapshot.job))
    .filter((name) => /weekly|monthly|sunday|\(1st of month\)/i.test(name))
    .slice(0, 2);

  const repeated = failedToday.filter((snapshot) => snapshot.consecutiveErrors >= 2);
  const isolated = failedToday.filter((snapshot) => snapshot.consecutiveErrors < 2);

  const lines = [
    "📋 Health Summary - Daily Cron Digest",
    buildHealthLine(options.health, options.heartbeatStatus),
    `📊 Cron Runs Today (${ranToday.length}/${enabledJobs.length})`,
  ];

  if (failedToday.length) {
    for (const snapshot of failedToday.slice(0, 4)) {
      lines.push(`❌ ${compactName(snapshot.job)} — failed (${formatDuration(snapshot.lastDurationMs)})`);
    }
  } else {
    lines.push("✅ No failed finished runs today.");
  }

  for (const snapshot of runningNow.slice(0, 2)) {
    lines.push(`⏳ ${compactName(snapshot.job)} — running now`);
  }

  for (const snapshot of missing.slice(0, 3)) {
    lines.push(`⚠️ Expected but missing: ${compactName(snapshot.job)}`);
  }

  if (notScheduledExamples.length) {
    lines.push(`⏭️ Not scheduled today: ${notScheduledExamples.join(", ")}`);
  }

  if (repeated.length) {
    lines.push(`Pattern: repeated failures active on ${repeated.map((snapshot) => compactName(snapshot.job)).join(", ")}.`);
  } else if (isolated.length) {
    lines.push("Pattern: failures look isolated.");
  } else {
    lines.push("Pattern: no current failure cluster.");
  }

  return lines.join("\n");
}

function readRuntimeJobs(jobsPath: string): RuntimeJob[] {
  const cliResult = spawnSync("openclaw", ["cron", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if ((cliResult.status ?? 1) === 0) {
    try {
      const parsed = JSON.parse(String(cliResult.stdout ?? "").trim()) as { jobs?: RuntimeJob[] };
      if (Array.isArray(parsed?.jobs)) return parsed.jobs;
    } catch {
      // fall through to file-based runtime snapshot
    }
  }

  const raw = fs.readFileSync(jobsPath, "utf8");
  const parsed = JSON.parse(raw) as { jobs?: RuntimeJob[] };
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

function readHealthSnapshot(): HealthSnapshot {
  try {
    fs.accessSync(PSQL_BIN, fs.constants.X_OK);
  } catch {
    return { errorCount: 0, cronFailCount: 0, warningCount: 0, criticalCount: 0 };
  }

  const env = withPostgresPath({
    ...process.env,
    PGHOST: process.env.PGHOST ?? "localhost",
    PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd",
  });

  const sql = [
    "SELECT json_build_object(",
    "  'severities', COALESCE((",
    "    SELECT jsonb_object_agg(severity, cnt)",
    "    FROM (",
    "      SELECT severity, COUNT(*)::int AS cnt",
    "      FROM cortana_events",
    "      WHERE timestamp >= ((timezone('America/New_York', now()))::date AT TIME ZONE 'America/New_York')",
    "      GROUP BY severity",
    "    ) counts",
    "  ), '{}'::jsonb),",
    "  'cronFails', COALESCE((",
    "    SELECT COUNT(*)::int",
    "    FROM cortana_events",
    "    WHERE timestamp >= ((timezone('America/New_York', now()))::date AT TIME ZONE 'America/New_York')",
    "      AND event_type = 'cron_fail'",
    "  ), 0)",
    ");",
  ].join(" ");

  const result = spawnSync(PSQL_BIN, ["cortana", "-At", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  if ((result.status ?? 1) !== 0) {
    return { errorCount: 0, cronFailCount: 0, warningCount: 0, criticalCount: 0 };
  }

  try {
    const parsed = JSON.parse(String(result.stdout ?? "").trim()) as {
      severities?: Record<string, number>;
      cronFails?: number;
    };
    const severities = parsed.severities ?? {};
    return {
      errorCount: parseNumber(severities.error),
      cronFailCount: parseNumber(parsed.cronFails),
      warningCount: parseNumber(severities.warning),
      criticalCount: parseNumber(severities.critical),
    };
  } catch {
    return { errorCount: 0, cronFailCount: 0, warningCount: 0, criticalCount: 0 };
  }
}

function parseArgs(argv: string[]): { selfJobId?: string } {
  const parsed: { selfJobId?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--self-id" && argv[index + 1]) {
      parsed.selfJobId = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

export { buildDigest, buildHealthLine, cronWindow, readLatestRunEntries, scheduleWindow, startOfDayMs, zonedParts };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobsPath = resolveRuntimeStatePath("cron", "jobs.json");
  const runDir = resolveRuntimeStatePath("cron", "runs");
  const heartbeatPath = defaultHeartbeatStatePath();
  const jobs = readRuntimeJobs(jobsPath);
  const latestEntriesByJobId: Record<string, CronRunEntry | null> = {};
  const latestFinishedByJobId: Record<string, CronRunEntry | null> = {};

  for (const job of jobs) {
    const jobId = String(job.id ?? "");
    if (!jobId) continue;
    const entries = readLatestRunEntries(runDir, jobId);
    latestEntriesByJobId[jobId] = entries.latestEntry;
    latestFinishedByJobId[jobId] = entries.latestFinished;
  }

  const rawHeartbeat = fs.existsSync(heartbeatPath) ? fs.readFileSync(heartbeatPath, "utf8") : null;
  const heartbeat = evaluateHeartbeatHealth(rawHeartbeat, {
    nowMs: Date.now(),
    statePath: heartbeatPath,
  });

  const output = buildDigest({
    now: new Date(),
    jobs,
    selfJobId: args.selfJobId,
    heartbeatStatus: heartbeat.status,
    health: readHealthSnapshot(),
    latestEntriesByJobId,
    latestFinishedByJobId,
  });

  console.log(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
