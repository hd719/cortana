#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveHomePath, resolveRepoPath } from "../lib/paths.js";

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

async function main(): Promise<number> {
  const runtimeJobs = resolveHomePath(".openclaw", "cron", "jobs.json");
  const repoJobs = resolveRepoPath("config", "cron", "jobs.json");
  const syncScript = resolveRepoPath("tools", "cron", "sync-cron-to-repo.sh");

  log("Starting OpenClaw post-update...");

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

  log("Running: openclaw gateway install --force");
  const install = spawnSync("openclaw", ["gateway", "install", "--force"], { stdio: "inherit" });
  if (install.status !== 0) return install.status ?? 1;

  log("Running: openclaw gateway restart");
  const restart = spawnSync("openclaw", ["gateway", "restart"], { stdio: "inherit" });
  if (restart.status !== 0) return restart.status ?? 1;

  if (isExecutable(syncScript)) {
    log("Syncing cron config: runtime → repo");
    const syncRes = spawnSync(syncScript, { stdio: "inherit" });
    if (syncRes.status !== 0) return syncRes.status ?? 1;
  } else {
    log("Sync script not found, copying manually");
    try {
      fs.copyFileSync(runtimeJobs, repoJobs);
    } catch {
      // ignore copy failures
    }
  }

  log("Post-update complete.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
