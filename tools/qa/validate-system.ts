#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { HEARTBEAT_MAX_AGE_MS, validateHeartbeatState } from "../lib/heartbeat-schema.js";
import { PSQL_BIN, resolveRepoPath } from "../lib/paths.js";
import { normalizeRuntimeCronConfig, splitRuntimeOnlyJobs, stableCronSemanticDigest } from "../lib/runtime-cron-jobs.js";
import { evaluateAgentProfileSync } from "./validate-agent-profile-sync.js";

type Check = {
  name: string;
  status: "pass" | "warn" | "fail";
  passed: boolean;
  details: Record<string, any>;
  message?: string;
};

type Json = Record<string, any>;

const REPO_ROOT = resolveRepoPath();
const DB_NAME = "cortana";
const RUNTIME_JOBS = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
const REPO_JOBS = path.join(REPO_ROOT, "config", "cron", "jobs.json");

const MEMORY_FILES = ["MEMORY.md", "SOUL.md", "USER.md", "IDENTITY.md"];

const REQUIRED_DB_TABLES = [
  "cortana_events",
  "cortana_tasks",
  "cortana_epics",
  "cortana_patterns",
  "cortana_self_model",
];

const REQUIRED_TOOLS = [
  "tools/subagent-watchdog/check-subagents.sh",
  "tools/heartbeat/validate-heartbeat-state.sh",
  "tools/session-reconciler/reconcile-sessions.sh",
  "tools/deploy/sync-runtime-from-cortana.sh",
  "tools/cron/sync-cron-to-runtime.ts",
];

const OPTIONAL_TOOLS = [
  "tools/task-board/completion-sync.sh",
  "tools/reaper/reaper.sh",
  "tools/notifications/telegram-delivery-guard.ts",
  "tools/deploy/ensure-deploy-worktree.sh",
  "tools/openclaw/runtime-integrity-check.ts",
];

function run(cmd: string[], cwd?: string): [number, string, string] {
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: "utf8",
  });
  return [proc.status ?? 1, (proc.stdout ?? "").trim(), (proc.stderr ?? "").trim()];
}

function makeCheck(name: string): Check {
  return { name, status: "pass", passed: true, details: {} };
}

function fail(check: Check, message: string): void {
  check.status = "fail";
  check.passed = false;
  check.message = message;
}

function warn(check: Check, message: string): void {
  if (check.status !== "fail") check.status = "warn";
  check.message = message;
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function checkRuntimeCronState(fix: boolean): Check {
  const check = makeCheck("runtime_cron_state");
  const exists = fs.existsSync(RUNTIME_JOBS) || isSymlink(RUNTIME_JOBS);
  const details: Json = {
    path: RUNTIME_JOBS,
    repo_path: REPO_JOBS,
    exists,
  };

  if (!fs.existsSync(REPO_JOBS)) {
    fail(check, "Repo cron jobs file is missing");
    check.details = details;
    return check;
  }

  if (!fs.existsSync(RUNTIME_JOBS)) {
    fail(check, "Runtime cron jobs file is missing");
    check.details = details;
    return check;
  }

  if (isSymlink(RUNTIME_JOBS)) {
    fail(check, "Runtime jobs.json must be a regular file, not a symlink");
    check.details = details;
    return check;
  }

  try {
    const repoJobs = JSON.parse(fs.readFileSync(REPO_JOBS, "utf8"));
    const runtimeJobs = JSON.parse(fs.readFileSync(RUNTIME_JOBS, "utf8"));
    const normalizedRuntimeJobs = normalizeRuntimeCronConfig(repoJobs, runtimeJobs);
    const { approvedManagedRuntimeOnlyJobs, unexpectedRuntimeOnlyJobs } = splitRuntimeOnlyJobs(repoJobs, runtimeJobs);
    details.semantic_match = stableCronSemanticDigest(repoJobs) === stableCronSemanticDigest(normalizedRuntimeJobs);
    details.preserved_managed_runtime_only_jobs = approvedManagedRuntimeOnlyJobs.map((job) => ({
      id: String(job.id ?? ""),
      name: String(job.name ?? ""),
    }));
    details.unexpected_runtime_only_jobs = unexpectedRuntimeOnlyJobs.map((job) => ({
      id: String(job.id ?? ""),
      name: String(job.name ?? ""),
    }));
    if (!details.semantic_match) {
      if (fix) {
        const [rc, out, err] = run([
          "npx",
          "tsx",
          path.join(REPO_ROOT, "tools", "cron", "sync-cron-to-runtime.ts"),
          "--repo-root",
          REPO_ROOT,
          "--runtime-home",
          os.homedir(),
        ]);
        details.fixed = rc === 0;
        details.fix_stdout = out;
        details.fix_stderr = err;
        if (rc !== 0) {
          fail(check, "Runtime cron sync fix failed");
        } else {
          const refreshed = JSON.parse(fs.readFileSync(RUNTIME_JOBS, "utf8"));
          const normalizedRefreshed = normalizeRuntimeCronConfig(repoJobs, refreshed);
          details.semantic_match = stableCronSemanticDigest(repoJobs) === stableCronSemanticDigest(normalizedRefreshed);
          if (!details.semantic_match) {
            fail(check, "Runtime cron sync fix completed but semantic drift remains");
          }
        }
      } else {
        fail(check, "Runtime cron config is not aligned with repo source config");
      }
    }
  } catch (err) {
    fail(check, `Invalid cron JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  check.details = details;
  return check;
}

function checkCronDefinitions(): Check {
  const check = makeCheck("cron_definitions");
  const details: Json = { path: REPO_JOBS, required_fields: ["id", "agentId", "name", "schedule", "enabled", "payload"] };

  if (!fs.existsSync(REPO_JOBS)) {
    fail(check, "config/cron/jobs.json is missing");
    check.details = details;
    return check;
  }

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(REPO_JOBS, "utf8"));
  } catch (err) {
    fail(check, `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    check.details = details;
    return check;
  }

  const jobs = data && typeof data === "object" ? data.jobs : null;
  if (!Array.isArray(jobs)) {
    fail(check, "jobs.json must contain a top-level 'jobs' array");
    check.details = details;
    return check;
  }

  const missingRequired: Json[] = [];
  const invalidSchedule: Json[] = [];
  const invalidPayload: Json[] = [];
  const missingRouting: Json[] = [];

  jobs.forEach((job: any, idx: number) => {
    if (!job || typeof job !== "object") {
      missingRequired.push({ index: idx, name: null, missing: ["<job is not an object>"] });
      return;
    }
    const jobName = job.name ?? `index:${idx}`;
    const missing = ["id", "agentId", "name", "schedule", "enabled", "payload"].filter((k) => !(k in job));
    if (missing.length) missingRequired.push({ index: idx, name: jobName, missing });

    const schedule = job.schedule;
    const scheduleObj = schedule && typeof schedule === "object" ? (schedule as Record<string, unknown>) : null;
    const scheduleKind = typeof scheduleObj?.kind === "string" ? scheduleObj.kind : null;
    const validCron = scheduleKind === "cron" && typeof scheduleObj?.expr === "string" && !!scheduleObj.expr.trim();
    const validEvery = scheduleKind === "every" && typeof scheduleObj?.everyMs === "number" && scheduleObj.everyMs > 0;
    if (!validCron && !validEvery) {
      invalidSchedule.push({ index: idx, name: jobName, kind: scheduleKind });
    }

    const payload = job.payload;
    if (!payload || typeof payload !== "object" || !("kind" in payload)) {
      invalidPayload.push({ index: idx, name: jobName, reason: "missing payload.kind" });
    } else if ((payload as Record<string, unknown>).kind === "agentTurn") {
      const message = (payload as Record<string, unknown>).message;
      if (typeof message !== "string" || !message.trim()) {
        invalidPayload.push({ index: idx, name: jobName, reason: "agentTurn missing payload.message" });
      }
    }

    const hasModel = "model" in job;
    const payloadModel = typeof job.payload === "object" && job.payload && "model" in job.payload;
    const hasAgentId = typeof job.agentId === "string" && job.agentId.trim().length > 0;
    if (!hasModel && !payloadModel && !hasAgentId) missingRouting.push({ index: idx, name: jobName });
  });

  details.job_count = jobs.length;
  details.missing_required = missingRequired;
  details.invalid_schedule = invalidSchedule;
  details.invalid_payload = invalidPayload;
  details.missing_routing = missingRouting;

  if (missingRequired.length) fail(check, "One or more cron jobs are missing required fields");
  else if (invalidSchedule.length) fail(check, "One or more cron jobs have invalid schedule definitions");
  else if (invalidPayload.length) fail(check, "One or more cron jobs have invalid payload definitions");
  else if (missingRouting.length) warn(check, "One or more cron jobs are missing model or agent routing");

  check.details = details;
  return check;
}

function checkRuntimeIntegrity(fix: boolean): Check {
  const check = makeCheck("runtime_integrity");
  const script = path.join(REPO_ROOT, "tools", "openclaw", "runtime-integrity-check.ts");
  const details: Json = { path: script, fix };

  if (!fs.existsSync(script)) {
    fail(check, "runtime integrity check script missing");
    check.details = details;
    return check;
  }

  const args = ["npx", "tsx", script, "--json"];
  if (fix) args.push("--repair");
  const [rc, out, err] = run(args, REPO_ROOT);
  details.stdout = out;
  details.stderr = err;

  try {
    const parsed = JSON.parse(out || "{}");
    details.overall_ok = Boolean(parsed.overall_ok);
    details.results = parsed.results ?? [];
    if (!parsed.overall_ok) fail(check, "Runtime integrity checks failed");
  } catch (error) {
    fail(check, `Runtime integrity output invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (rc !== 0 && check.status === "pass") fail(check, err || out || "Runtime integrity check failed");
  check.details = details;
  return check;
}

function checkDbConnectivity(): Check {
  const check = makeCheck("db_connectivity");
  const details: Json = { psql_path: PSQL_BIN, database: DB_NAME, required_tables: REQUIRED_DB_TABLES };

  if (!fs.existsSync(PSQL_BIN)) {
    fail(check, "psql binary not found");
    check.details = details;
    return check;
  }

  let rc: number;
  let out: string;
  let err: string;

  [rc, out, err] = run([PSQL_BIN, DB_NAME, "-t", "-A", "-c", "SELECT 1;"]);
  details.connect_stdout = out;
  if (rc !== 0) {
    fail(check, `Cannot connect to PostgreSQL/${DB_NAME}: ${err || out}`);
    check.details = details;
    return check;
  }

  const sql =
    "SELECT table_name FROM information_schema.tables " +
    "WHERE table_schema='public' AND table_name = ANY(ARRAY[" +
    REQUIRED_DB_TABLES.map((t) => `'${t}'`).join(",") +
    "])";

  [rc, out, err] = run([PSQL_BIN, DB_NAME, "-t", "-A", "-c", sql]);
  if (rc !== 0) {
    fail(check, `Failed checking required tables: ${err || out}`);
    check.details = details;
    return check;
  }

  const found = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const missing = REQUIRED_DB_TABLES.filter((t) => !found.includes(t)).sort();
  details.found_tables = found;
  details.missing_tables = missing;

  if (missing.length) fail(check, "Database is reachable but missing required tables");

  check.details = details;
  return check;
}

function checkCriticalTools(): Check {
  const check = makeCheck("critical_tools");
  const details: Json = { required: [], optional: [] };

  const missing: string[] = [];
  for (const rel of REQUIRED_TOOLS) {
    const p = path.join(REPO_ROOT, rel);
    const exists = fs.existsSync(p);
    const executable = exists ? fs.accessSync(p, fs.constants.X_OK) === undefined : false;
    details.required.push({ path: rel, exists, executable, required: true });
    if (!exists || !executable) missing.push(rel);
  }

  for (const rel of OPTIONAL_TOOLS) {
    const p = path.join(REPO_ROOT, rel);
    const exists = fs.existsSync(p);
    let executable: boolean | null = null;
    if (exists) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        executable = true;
      } catch {
        executable = false;
      }
    }
    details.optional.push({ path: rel, exists, executable, required: false });
  }

  if (missing.length) fail(check, `Missing or non-executable required tools: ${missing.join(", ")}`);

  check.details = details;
  return check;
}

function checkHeartbeatState(): Check {
  const check = makeCheck("heartbeat_state");
  const nowMs = Date.now();
  const runtimePath = path.join(os.homedir(), ".openclaw", "memory", "heartbeat-state.json");
  const repoPath = path.join(REPO_ROOT, "memory", "heartbeat-state.json");
  const details: Json = {
    runtime_path: runtimePath,
    repo_path: repoPath,
    runtime_exists: fs.existsSync(runtimePath),
    repo_exists: fs.existsSync(repoPath),
  };

  if (!details.runtime_exists && !details.repo_exists) {
    fail(check, "heartbeat-state.json is missing (runtime + repo)");
    check.details = details;
    return check;
  }

  const candidates = [runtimePath, repoPath]
    .filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index)
    .map((filePath) => {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const validated = validateHeartbeatState(data, nowMs, HEARTBEAT_MAX_AGE_MS);
        const latestHeartbeatMs = Math.max(
          validated.lastHeartbeat,
          ...Object.values(validated.lastChecks).map((value) => value.lastChecked),
        );

        return {
          path: filePath,
          ok: true,
          validated,
          latestHeartbeatMs,
          ageMs: Math.max(0, nowMs - latestHeartbeatMs),
        };
      } catch (err) {
        return {
          path: filePath,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

  details.candidates = candidates.map((candidate) =>
    candidate.ok
      ? {
          path: candidate.path,
          ok: true,
          age_ms: candidate.ageMs,
          latest_heartbeat_at: new Date(candidate.latestHeartbeatMs).toISOString(),
        }
      : {
          path: candidate.path,
          ok: false,
          error: candidate.error,
        },
  );

  const validCandidates = candidates.filter((candidate) => candidate.ok);
  if (!validCandidates.length) {
    fail(check, "Invalid heartbeat-state JSON/semantics in runtime + repo locations");
    check.details = details;
    return check;
  }

  validCandidates.sort((a, b) => b.latestHeartbeatMs - a.latestHeartbeatMs);
  const selected = validCandidates[0];
  details.path = selected.path;
  details.selected_path = selected.path;
  details.version = selected.validated.version;
  details.required_keys = Object.keys(selected.validated.lastChecks);
  details.oldest_check_age_ms = Math.max(
    ...Object.values(selected.validated.lastChecks).map((v) => Math.max(0, nowMs - v.lastChecked)),
  );
  details.latest_heartbeat_at = new Date(selected.latestHeartbeatMs).toISOString();
  details.latest_heartbeat_age_ms = selected.ageMs;

  if (validCandidates.length >= 2) {
    const newest = validCandidates[0];
    const next = validCandidates[1];
    const divergenceMs = Math.abs(newest.latestHeartbeatMs - next.latestHeartbeatMs);
    details.split_brain = divergenceMs > 5 * 60 * 1000;
    details.divergence_ms = divergenceMs;

    if (details.split_brain) {
      warn(
        check,
        "Runtime and repo heartbeat-state files diverge; stale path may trigger false watchdog alerts",
      );
    }
  }

  check.details = details;
  return check;
}

function checkMemoryFiles(): Check {
  const check = makeCheck("memory_files");
  const details: Json = { files: [] };
  const bad: string[] = [];

  for (const fname of MEMORY_FILES) {
    const p = path.join(REPO_ROOT, fname);
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : 0;
    const nonEmpty = size > 0;
    details.files.push({ path: fname, exists, size, non_empty: nonEmpty });
    if (!exists || !nonEmpty) bad.push(fname);
  }

  if (bad.length) fail(check, `Missing or empty memory files: ${bad.join(", ")}`);

  check.details = details;
  return check;
}

function checkAgentProfileSync(): Check {
  const check = makeCheck("agent_profile_sync");
  const report = evaluateAgentProfileSync();
  check.details = report;

  if (!report.ok) {
    fail(check, "config/agent-profiles.json is not aligned with config/openclaw.json");
  }

  return check;
}

function checkGitStatus(): Check {
  const check = makeCheck("git_status");
  const details: Json = {};

  const [rc, out, err] = run(["git", "status", "--porcelain"], REPO_ROOT);
  if (rc !== 0) {
    fail(check, `git status failed: ${err || out}`);
    check.details = details;
    return check;
  }

  let modified = 0;
  let untracked = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untracked += 1;
    else modified += 1;
  }

  details.modified_count = modified;
  details.untracked_count = untracked;
  details.total_changes = modified + untracked;
  details.clean = modified + untracked === 0;

  check.details = details;
  return check;
}

function checkDiskSpace(): Check {
  const check = makeCheck("disk_space");
  const stat = fs.statfsSync("/");
  const freeBytes = stat.bsize * stat.bfree;
  const totalBytes = stat.bsize * stat.blocks;
  const freeGb = freeBytes / 1024 ** 3;
  const totalGb = totalBytes / 1024 ** 3;
  const details = {
    mount: "/",
    free_bytes: freeBytes,
    free_gb: Math.round(freeGb * 100) / 100,
    total_gb: Math.round(totalGb * 100) / 100,
    threshold_gb: 5,
  };

  if (freeGb < 5) warn(check, "Free disk space is below 5GB");

  check.details = details;
  return check;
}

function parseSimpleStep(field: string): number | null {
  if (field.startsWith("*/")) {
    const v = Number(field.slice(2));
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function parseIntList(field: string, minV: number, maxV: number): number[] | null {
  if (!field || field.includes("*") || field.includes("/")) return null;
  const out: number[] = [];
  for (const part of field.split(",")) {
    const t = part.trim();
    if (!/^\d+$/.test(t)) return null;
    const v = Number(t);
    if (v < minV || v > maxV) return null;
    out.push(v);
  }
  return out.length ? Array.from(new Set(out)).sort((a, b) => a - b) : null;
}

function estimateIntervalMs(expr: string): number | null {
  const parts = expr.split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour] = parts;

  const minuteStep = parseSimpleStep(minute);
  const hourStep = parseSimpleStep(hour);
  if (hourStep && hourStep > 0) return hourStep * 60 * 60 * 1000;

  const hourValues = parseIntList(hour, 0, 23);
  if (hourValues) {
    if (hourValues.length === 1) return 24 * 60 * 60 * 1000;
    const diffs: number[] = [];
    for (let i = 0; i < hourValues.length; i += 1) {
      const cur = hourValues[i];
      const nxt = hourValues[(i + 1) % hourValues.length];
      const diff = (nxt - cur + 24) % 24;
      if (diff !== 0) diffs.push(diff);
    }
    if (diffs.length) return Math.min(...diffs) * 60 * 60 * 1000;
  }

  if (hour === "*") {
    if (minuteStep && minuteStep > 0) return minuteStep * 60 * 1000;
    const minuteValues = parseIntList(minute, 0, 59);
    if (minuteValues) {
      if (minuteValues.length === 1) return 60 * 60 * 1000;
      const diffs: number[] = [];
      for (let i = 0; i < minuteValues.length; i += 1) {
        const cur = minuteValues[i];
        const nxt = minuteValues[(i + 1) % minuteValues.length];
        const diff = (nxt - cur + 60) % 60;
        if (diff !== 0) diffs.push(diff);
      }
      if (diffs.length) return Math.min(...diffs) * 60 * 1000;
    }
    return 60 * 60 * 1000;
  }

  return null;
}

function checkCronStaleness(fix: boolean): Check {
  const check = makeCheck("cron_staleness");
  const details: Json = { path: RUNTIME_JOBS, late_jobs: [], fix_attempts: [] };

  if (!fs.existsSync(RUNTIME_JOBS)) {
    fail(check, "Runtime cron jobs file is missing");
    check.details = details;
    return check;
  }

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(RUNTIME_JOBS, "utf8"));
  } catch (err) {
    fail(check, `Invalid runtime jobs JSON: ${err instanceof Error ? err.message : String(err)}`);
    check.details = details;
    return check;
  }

  const jobs = data && typeof data === "object" ? data.jobs : null;
  if (!Array.isArray(jobs)) {
    fail(check, "Runtime jobs.json must contain a top-level 'jobs' array");
    check.details = details;
    return check;
  }

  const nowMs = Math.trunc(Date.now());
  details.now_ms = nowMs;
  details.job_count = jobs.length;

  let enabledCount = 0;
  let analyzedCount = 0;

  jobs.forEach((job: any, idx: number) => {
    if (!job || typeof job !== "object") return;
    if (!job.enabled) return;
    enabledCount += 1;

    const jobId = String(job.id ?? job.name ?? `index:${idx}`);
    const schedule = job.schedule && typeof job.schedule === "object" ? job.schedule : {};
    const expr = schedule.expr;
    const state = job.state && typeof job.state === "object" ? job.state : {};
    if (!expr || typeof expr !== "string" || !expr.trim()) return;

    const expectedIntervalMs = estimateIntervalMs(expr.trim());
    if (!expectedIntervalMs) return;

    let lastRunAt = state.lastRunAt;
    if (typeof lastRunAt !== "number") lastRunAt = state.lastFiredAt;
    if (typeof lastRunAt !== "number") return;

    analyzedCount += 1;
    const lagMs = Math.max(0, nowMs - Math.trunc(lastRunAt));
    const staleThresholdMs = expectedIntervalMs * 2;
    if (lagMs > staleThresholdMs) {
      const lateByMs = lagMs - staleThresholdMs;
      details.late_jobs.push({
        id: jobId,
        name: job.name,
        expr,
        last_run_at_ms: Math.trunc(lastRunAt),
        lag_ms: lagMs,
        expected_interval_ms: expectedIntervalMs,
        stale_threshold_ms: staleThresholdMs,
        late_by_ms: lateByMs,
      });
    }
  });

  details.enabled_jobs = enabledCount;
  details.analyzed_jobs = analyzedCount;

  if (details.late_jobs.length) {
    if (fix) {
      for (const item of details.late_jobs) {
        const [rc, out, err] = run(["openclaw", "cron", "run", item.id]);
        details.fix_attempts.push({ id: item.id, rc, stdout: out, stderr: err, ok: rc === 0 });
      }
      const failed = details.fix_attempts.filter((x: any) => !x.ok);
      if (failed.length) warn(check, `Found ${details.late_jobs.length} stale job(s); some fix attempts failed`);
      else warn(check, `Found and force-ran ${details.late_jobs.length} stale job(s)`);
    } else {
      warn(check, `Found ${details.late_jobs.length} stale cron job(s)`);
    }
  }

  check.details = details;
  return check;
}

function summarize(checks: Check[]): Json {
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "pass").length;
  return {
    overall_ok: failed === 0,
    counts: { pass: passed, warn: warned, fail: failed, total: checks.length },
  };
}

function printHuman(report: Json, verbose: boolean): void {
  console.log("OpenClaw System Validation");
  console.log("=".repeat(28));
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Repo: ${report.repo_root}`);
  console.log();

  for (const c of report.checks as Check[]) {
    const icon = c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : c.status === "fail" ? "❌" : "•";
    console.log(`${icon} ${c.name}: ${c.status.toUpperCase()}`);
    if (c.message) console.log(`   ${c.message}`);
    if (verbose) {
      console.log("   details:");
      console.log("   " + JSON.stringify(c.details ?? {}, null, 2).replace(/\n/g, "\n   "));
    }
  }

  const counts = report.summary.counts;
  console.log();
  console.log(
    `Result: ${report.summary.overall_ok ? "PASS" : "FAIL"} (pass=${counts.pass}, warn=${counts.warn}, fail=${counts.fail})`
  );
}

type Args = { json: boolean; fix: boolean; verbose: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, fix: false, verbose: false };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    if (arg === "--fix") args.fix = true;
    if (arg === "--verbose") args.verbose = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const checks: Check[] = [
    checkRuntimeCronState(args.fix),
    checkCronDefinitions(),
    checkAgentProfileSync(),
    checkRuntimeIntegrity(args.fix),
    checkDbConnectivity(),
    checkCriticalTools(),
    checkHeartbeatState(),
    checkMemoryFiles(),
    checkGitStatus(),
    checkDiskSpace(),
  ];

  const report: Json = {
    timestamp: new Date().toISOString(),
    repo_root: REPO_ROOT,
    options: { json: args.json, fix: args.fix, verbose: args.verbose },
    checks,
  };
  report.summary = summarize(checks);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report, args.verbose);

  process.exit(report.summary.overall_ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
