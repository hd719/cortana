#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { resolveHomePath, sourceRepoRoot } from "../lib/paths.js";

const CANONICAL_REPO_ROOT = sourceRepoRoot();

function log(message: string): void {
  process.stdout.write(`[post-update] ${message}\n`);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): { validateOnly: boolean; skipRestart: boolean } {
  return {
    validateOnly: argv.includes("--validate-only"),
    skipRestart: argv.includes("--skip-restart"),
  };
}

function ensureRegularRuntimeJobs(runtimeJobs: string): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(runtimeJobs);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (!err || err.code !== "ENOENT") throw error;
    stat = null;
  }

  if (stat?.isSymbolicLink()) {
    const target = fs.readlinkSync(runtimeJobs);
    log(`Removing symlink (${runtimeJobs} -> ${target}) — gateway needs a regular file.`);
    fs.copyFileSync(target, `${runtimeJobs}.tmp`);
    fs.rmSync(runtimeJobs, { force: true });
    fs.renameSync(`${runtimeJobs}.tmp`, runtimeJobs);
  }
}

function syncCronConfig(runtimeJobs: string, repoJobs: string): void {
  const syncTsScript = path.join(CANONICAL_REPO_ROOT, "tools", "cron", "sync-cron-to-runtime.ts");

  if (fs.existsSync(syncTsScript)) {
    log("Syncing cron config via tsx script: repo → runtime state");
    const syncRes = spawnSync("npx", ["tsx", syncTsScript, "--repo-root", CANONICAL_REPO_ROOT, "--runtime-home", os.homedir()], {
      stdio: "inherit",
    });
    if (syncRes.status !== 0) {
      throw new Error(`sync ts script failed with status ${syncRes.status ?? 1}`);
    }
    return;
  }

  log("Sync script not found, copying repo jobs.json into runtime state");
  fs.mkdirSync(path.dirname(runtimeJobs), { recursive: true });
  fs.copyFileSync(repoJobs, runtimeJobs);
}

function ensureCompatShim(): void {
  const shimScript = path.join(CANONICAL_REPO_ROOT, "tools", "openclaw", "install-compat-shim.sh");
  if (!fs.existsSync(shimScript)) {
    throw new Error(`compat shim installer missing: ${shimScript}`);
  }

  log(`Ensuring ~/openclaw compatibility shim points at the canonical source repo (${CANONICAL_REPO_ROOT})`);
  const res = spawnSync("bash", [shimScript, "--source-repo", CANONICAL_REPO_ROOT], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`compat shim install failed with status ${res.status ?? 1}`);
  }
}

function buildDetachedLaunchdRestartScript(uid: string, label: string, plistPath: string, helperLog: string): string {
  const notifyScript = path.join(CANONICAL_REPO_ROOT, "tools", "notifications", "telegram-delivery-guard.sh");
  const failureMsg = "🚨 System - OpenClaw post-update restart failed. Gateway did not verify as running after detached restart helper. Manual check needed.";

  return [
    "set -euo pipefail",
    `exec >>${JSON.stringify(helperLog)} 2>&1`,
    `notify_failure() { echo \"[$(date '+%Y-%m-%d %H:%M:%S')] paging Hamel about restart failure\"; ${JSON.stringify(notifyScript)} ${JSON.stringify(failureMsg)} 8171372724 0 gateway_post_update_restart_failed gateway-post-update-restart P1 monitor System now >/dev/null 2>&1 || true; }`,
    "trap 'notify_failure' ERR",
    "echo \"[$(date '+%Y-%m-%d %H:%M:%S')] detached restart helper starting\"",
    "sleep 2",
    `launchctl bootout gui/${uid}/${label} >/dev/null 2>&1 || true`,
    `launchctl bootstrap gui/${uid} ${JSON.stringify(plistPath)}`,
    `launchctl enable gui/${uid}/${label} >/dev/null 2>&1 || true`,
    `launchctl kickstart -k gui/${uid}/${label}`,
    "sleep 3",
    `launchctl print gui/${uid}/${label} | /usr/bin/grep -q 'state = running'`,
    "trap - ERR",
    "echo \"[$(date '+%Y-%m-%d %H:%M:%S')] detached restart helper finished (verified running)\"",
  ].join("; ");
}

function scheduleDetachedLaunchdRestart(): void {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : process.env.UID ?? "501";
  const label = "ai.openclaw.gateway";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const helperLog = resolveHomePath(".openclaw", "logs", "post-update-restart.log");
  const helperScript = buildDetachedLaunchdRestartScript(uid, label, plistPath, helperLog);

  fs.mkdirSync(path.dirname(helperLog), { recursive: true });
  const child = spawn("/bin/bash", ["-lc", helperScript], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function validatePostUpdate(runtimeJobs: string, repoJobs: string): void {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : process.env.UID ?? "501";
  const label = "ai.openclaw.gateway";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const helperLog = resolveHomePath(".openclaw", "logs", "post-update-restart.log");

  const problems: string[] = [];

  if (!fs.existsSync(runtimeJobs)) problems.push(`runtime jobs missing: ${runtimeJobs}`);
  if (!fs.existsSync(repoJobs)) problems.push(`repo jobs missing: ${repoJobs}`);
  if (fs.existsSync(runtimeJobs) && fs.lstatSync(runtimeJobs).isSymbolicLink()) {
    problems.push(`runtime jobs is still a symlink: ${runtimeJobs}`);
  }
  if (!fs.existsSync(plistPath)) problems.push(`launch agent missing: ${plistPath}`);

  const installCheck = spawnSync("openclaw", ["gateway", "status"], { encoding: "utf8" });
  if (installCheck.status !== 0) {
    problems.push(`gateway status failed: ${installCheck.stderr || installCheck.stdout || `exit ${installCheck.status ?? 1}`}`);
  }

  const helperScript = buildDetachedLaunchdRestartScript(uid, label, plistPath, helperLog);
  if (!helperScript.includes("launchctl kickstart -k") || !helperScript.includes("state = running") || !helperScript.includes("notify_failure")) {
    problems.push("detached restart helper is missing kickstart, verification, or failure paging logic");
  }

  if (problems.length > 0) {
    throw new Error(`validation failed:\n- ${problems.join("\n- ")}`);
  }

  log("Validation OK: repo/runtime jobs files exist, runtime jobs is regular, gateway status is reachable, detached helper includes verification.");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runtimeJobs = resolveHomePath(".openclaw", "cron", "jobs.json");
  const repoJobs = path.join(CANONICAL_REPO_ROOT, "config", "cron", "jobs.json");

  log("Starting OpenClaw post-update...");

  ensureCompatShim();
  ensureRegularRuntimeJobs(runtimeJobs);
  syncCronConfig(runtimeJobs, repoJobs);
  validatePostUpdate(runtimeJobs, repoJobs);

  if (args.validateOnly) {
    log("Validate-only mode complete.");
    return 0;
  }

  log("Running: openclaw doctor");
  const doctor = spawnSync("openclaw", ["doctor"], { stdio: "inherit" });
  if (doctor.status !== 0) return doctor.status ?? 1;

  log("Running: openclaw gateway install --force");
  const install = spawnSync("openclaw", ["gateway", "install", "--force"], { stdio: "inherit" });
  if (install.status !== 0) return install.status ?? 1;

  if (args.skipRestart) {
    log("Skip-restart mode complete after doctor + install.");
    return 0;
  }

  log("Scheduling detached launchd restart helper (safer than inline restart from a live gateway-owned process)");
  scheduleDetachedLaunchdRestart();

  log("Post-update complete. Gateway restart has been handed off to detached helper with verification.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
