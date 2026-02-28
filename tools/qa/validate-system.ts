#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { repoRoot, resolveRepoPath } from "../lib/paths.js";
import { readJsonFile } from "../lib/json-file.js";

const REPO_ROOT = repoRoot();
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB_NAME = "cortana";

const RUNTIME_JOBS = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
const REPO_JOBS = resolveRepoPath("config", "cron", "jobs.json");

const MEMORY_FILES = ["MEMORY.md", "SOUL.md", "USER.md", "IDENTITY.md"];
const REQUIRED_DB_TABLES = ["cortana_events", "cortana_tasks", "cortana_epics", "cortana_feedback", "cortana_patterns", "cortana_self_model"];
const REQUIRED_TOOLS = ["tools/subagent-watchdog/check-subagents.sh", "tools/heartbeat/validate-heartbeat-state.sh", "tools/session-reconciler/reconcile-sessions.sh"];
const OPTIONAL_TOOLS = ["tools/task-board/completion-sync.sh", "tools/reaper/reaper.sh", "tools/notifications/telegram-delivery-guard.sh"];

type Check = { name: string; status: "pass" | "warn" | "fail"; passed: boolean; message?: string; details: any };

function run(cmd: string[], cwd?: string): [number, string, string] {
  const proc = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
  return [proc.status ?? 1, (proc.stdout || "").trim(), (proc.stderr || "").trim()];
}
const makeCheck = (name: string): Check => ({ name, status: "pass", passed: true, details: {} });
const fail = (c: Check, msg: string) => { c.status = "fail"; c.passed = false; c.message = msg; };
const warn = (c: Check, msg: string) => { if (c.status !== "fail") c.status = "warn"; c.message = msg; };

function checkSymlink(fixFlag: boolean): Check {
  const c = makeCheck("symlink_integrity");
  const details: any = { path: RUNTIME_JOBS, expected_target: REPO_JOBS, exists: fs.existsSync(RUNTIME_JOBS) };
  try {
    if (fs.lstatSync(RUNTIME_JOBS).isSymbolicLink()) {
      const actual = fs.readlinkSync(RUNTIME_JOBS);
      const resolved = fs.existsSync(RUNTIME_JOBS) ? fs.realpathSync(RUNTIME_JOBS) : null;
      details.actual_target = actual;
      details.resolved_target = resolved;
      if (resolved !== REPO_JOBS) {
        if (fixFlag) {
          fs.mkdirSync(path.dirname(RUNTIME_JOBS), { recursive: true });
          try { fs.unlinkSync(RUNTIME_JOBS); } catch {}
          fs.symlinkSync(REPO_JOBS, RUNTIME_JOBS);
          details.fixed = true; details.actual_target = REPO_JOBS; details.resolved_target = REPO_JOBS;
        } else fail(c, "Symlink points to the wrong target");
      } else if (!fs.existsSync(RUNTIME_JOBS)) fail(c, "Symlink exists but target is broken/missing");
    } else {
      details.is_symlink = false;
      if (fixFlag) {
        fs.mkdirSync(path.dirname(RUNTIME_JOBS), { recursive: true });
        if (fs.existsSync(RUNTIME_JOBS)) fs.unlinkSync(RUNTIME_JOBS);
        fs.symlinkSync(REPO_JOBS, RUNTIME_JOBS);
        details.fixed = true; details.actual_target = REPO_JOBS; details.resolved_target = REPO_JOBS;
      } else fail(c, "jobs.json is missing or not a symlink");
    }
  } catch {
    if (fixFlag) {
      fs.mkdirSync(path.dirname(RUNTIME_JOBS), { recursive: true });
      try { if (fs.existsSync(RUNTIME_JOBS)) fs.unlinkSync(RUNTIME_JOBS); } catch {}
      fs.symlinkSync(REPO_JOBS, RUNTIME_JOBS);
      details.fixed = true; details.actual_target = REPO_JOBS; details.resolved_target = REPO_JOBS;
    } else fail(c, "jobs.json is missing or not a symlink");
  }
  c.details = details;
  return c;
}

function checkCronDefinitions(): Check {
  const c = makeCheck("cron_definitions");
  const details: any = { path: REPO_JOBS, required_fields: ["name", "schedule", "enabled", "command"] };
  if (!fs.existsSync(REPO_JOBS)) { fail(c, "config/cron/jobs.json is missing"); c.details = details; return c; }
  const data = readJsonFile<any>(REPO_JOBS);
  if (!data) { fail(c, "Invalid JSON"); c.details = details; return c; }
  const jobs = data.jobs;
  if (!Array.isArray(jobs)) { fail(c, "jobs.json must contain a top-level 'jobs' array"); c.details = details; return c; }

  const missingReq: any[] = [];
  const missingModel: any[] = [];
  jobs.forEach((job: any, idx: number) => {
    if (!job || typeof job !== "object") { missingReq.push({ index: idx, name: null, missing: ["<job is not an object>"] }); return; }
    const name = job.name ?? `index:${idx}`;
    const missing = ["name", "schedule", "enabled", "command"].filter((k) => !(k in job));
    if (missing.length) missingReq.push({ index: idx, name, missing });
    const hasModel = "model" in job;
    const payloadModel = job.payload && typeof job.payload === "object" && "model" in job.payload;
    if (!hasModel && !payloadModel) missingModel.push({ index: idx, name });
  });

  details.job_count = jobs.length; details.missing_required = missingReq; details.missing_model = missingModel;
  if (missingReq.length) fail(c, "One or more cron jobs are missing required fields");
  else if (missingModel.length) warn(c, "One or more cron jobs are missing a model field");
  c.details = details;
  return c;
}

function checkDbConnectivity(): Check {
  const c = makeCheck("db_connectivity");
  const details: any = { psql_path: PSQL, database: DB_NAME, required_tables: REQUIRED_DB_TABLES };
  if (!fs.existsSync(PSQL)) { fail(c, "psql binary not found"); c.details = details; return c; }

  const [rc, out, err] = run([PSQL, DB_NAME, "-t", "-A", "-c", "SELECT 1;"]);
  details.connect_stdout = out;
  if (rc !== 0) { fail(c, `Cannot connect to PostgreSQL/${DB_NAME}: ${err || out}`); c.details = details; return c; }

  const sql = `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY(ARRAY[${REQUIRED_DB_TABLES.map((t) => `'${t}'`).join(",")}])`;
  const [trc, tout, terr] = run([PSQL, DB_NAME, "-t", "-A", "-c", sql]);
  if (trc !== 0) { fail(c, `Failed checking required tables: ${terr || tout}`); c.details = details; return c; }
  const found = tout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).sort();
  const missing = REQUIRED_DB_TABLES.filter((t) => !found.includes(t)).sort();
  details.found_tables = found; details.missing_tables = missing;
  if (missing.length) fail(c, "Database is reachable but missing required tables");
  c.details = details;
  return c;
}

function checkCriticalTools(): Check {
  const c = makeCheck("critical_tools");
  const details: any = { required: [], optional: [] };
  const bad: string[] = [];
  for (const rel of REQUIRED_TOOLS) {
    const p = path.join(REPO_ROOT, rel);
    const exists = fs.existsSync(p);
    let executable = false;
    if (exists) {
      try { fs.accessSync(p, fs.constants.X_OK); executable = true; } catch { executable = false; }
    }
    details.required.push({ path: rel, exists, executable, required: true });
    if (!exists || !executable) bad.push(rel);
  }
  for (const rel of OPTIONAL_TOOLS) {
    const p = path.join(REPO_ROOT, rel);
    const exists = fs.existsSync(p);
    let executable: boolean | null = null;
    if (exists) { try { fs.accessSync(p, fs.constants.X_OK); executable = true; } catch { executable = false; } }
    details.optional.push({ path: rel, exists, executable, required: false });
  }
  if (bad.length) fail(c, `Missing or non-executable required tools: ${bad.join(", ")}`);
  c.details = details;
  return c;
}

function checkHeartbeatState(): Check {
  const c = makeCheck("heartbeat_state");
  const p = path.join(REPO_ROOT, "memory", "heartbeat-state.json");
  const details: any = { path: p };
  if (!fs.existsSync(p)) { fail(c, "heartbeat-state.json is missing"); c.details = details; return c; }
  const data = readJsonFile<any>(p);
  if (!data) { fail(c, "Invalid heartbeat-state JSON"); c.details = details; return c; }
  details.version = data.version;
  if (typeof data.version !== "number" || data.version < 2) fail(c, "heartbeat-state version must be >= 2");
  c.details = details;
  return c;
}

function checkMemoryFiles(): Check {
  const c = makeCheck("memory_files");
  const details: any = { files: [] };
  const bad: string[] = [];
  for (const f of MEMORY_FILES) {
    const p = path.join(REPO_ROOT, f);
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : 0;
    const nonEmpty = size > 0;
    details.files.push({ path: f, exists, size, non_empty: nonEmpty });
    if (!exists || !nonEmpty) bad.push(f);
  }
  if (bad.length) fail(c, `Missing or empty memory files: ${bad.join(", ")}`);
  c.details = details;
  return c;
}

function checkGitStatus(): Check {
  const c = makeCheck("git_status");
  const [rc, out, err] = run(["git", "status", "--porcelain"], REPO_ROOT);
  const details: any = {};
  if (rc !== 0) { fail(c, `git status failed: ${err || out}`); c.details = details; return c; }
  let modified = 0; let untracked = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("??")) untracked += 1;
    else modified += 1;
  }
  details.modified_count = modified; details.untracked_count = untracked; details.total_changes = modified + untracked; details.clean = modified + untracked === 0;
  c.details = details;
  return c;
}

function checkDiskSpace(): Check {
  const c = makeCheck("disk_space");
  const d = fs.statfsSync("/");
  const free = d.bfree * d.bsize;
  const total = d.blocks * d.bsize;
  const freeGb = free / 1024 ** 3;
  c.details = { mount: "/", free_bytes: free, free_gb: Math.round(freeGb * 100) / 100, total_gb: Math.round((total / 1024 ** 3) * 100) / 100, threshold_gb: 5 };
  if (freeGb < 5) warn(c, "Free disk space is below 5GB");
  return c;
}

function summarize(checks: Check[]) {
  const failed = checks.filter((x) => x.status === "fail").length;
  const warned = checks.filter((x) => x.status === "warn").length;
  const passed = checks.filter((x) => x.status === "pass").length;
  return { overall_ok: failed === 0, counts: { pass: passed, warn: warned, fail: failed, total: checks.length } };
}

function printHuman(report: any, verbose: boolean) {
  console.log("OpenClaw System Validation");
  console.log("============================");
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Repo: ${report.repo_root}`);
  console.log();
  for (const c of report.checks) {
    const icon = c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌";
    console.log(`${icon} ${c.name}: ${String(c.status).toUpperCase()}`);
    if (c.message) console.log(`   ${c.message}`);
    if (verbose) {
      console.log("   details:");
      console.log("   " + JSON.stringify(c.details ?? {}, null, 2).replace(/\n/g, "\n   "));
    }
  }
  const counts = report.summary.counts;
  console.log();
  console.log(`Result: ${report.summary.overall_ok ? "PASS" : "FAIL"} (pass=${counts.pass}, warn=${counts.warn}, fail=${counts.fail})`);
}

function main(): number {
  const argv = process.argv.slice(2);
  const jsonFlag = argv.includes("--json");
  const fixFlag = argv.includes("--fix");
  const verbose = argv.includes("--verbose");

  const checks = [
    checkSymlink(fixFlag),
    checkCronDefinitions(),
    checkDbConnectivity(),
    checkCriticalTools(),
    checkHeartbeatState(),
    checkMemoryFiles(),
    checkGitStatus(),
    checkDiskSpace(),
  ];

  const report: any = {
    timestamp: new Date().toISOString(),
    repo_root: REPO_ROOT,
    options: { json: jsonFlag, fix: fixFlag, verbose },
    checks,
  };
  report.summary = summarize(checks);

  if (jsonFlag) console.log(JSON.stringify(report, null, 2));
  else printHuman(report, verbose);

  return report.summary.overall_ok ? 0 : 1;
}

process.exit(main());
