#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVacationOpsConfig } from "../vacation/vacation-config.js";
import { getActiveVacationWindow, reconcileVacationMirror, updateVacationWindow } from "../vacation/vacation-state.js";
import { disableVacationMode } from "../vacation/vacation-state-machine.js";

type CronJob = {
  id?: string;
  name?: string;
  enabled?: boolean;
  state?: {
    consecutiveErrors?: number;
  };
  updatedAtMs?: number;
};

type RuntimeJobsDoc = {
  jobs?: CronJob[];
};

const RUNTIME_JOBS_PATH = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
const QUARANTINE_DIR = path.join(os.homedir(), ".openclaw", "cron", "quarantine");

function readRuntimeJobs(runtimeJobsPath = RUNTIME_JOBS_PATH): RuntimeJobsDoc | null {
  try {
    return JSON.parse(fs.readFileSync(runtimeJobsPath, "utf8")) as RuntimeJobsDoc;
  } catch {
    return null;
  }
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function shouldMatch(name: string, matchers: string[]): boolean {
  const haystack = normalize(name);
  return matchers.some((matcher) => haystack.includes(normalize(matcher)));
}

function quarantineJob(job: CronJob, quarantineDir = QUARANTINE_DIR): void {
  fs.mkdirSync(quarantineDir, { recursive: true });
  const safeName = (job.name ?? job.id ?? "unknown").replace(/[\\/]/g, "_");
  const quarantineFile = path.join(quarantineDir, `${safeName}.quarantined`);
  const content = `${new Date().toISOString()} vacation-mode fragile quarantine (consecutive errors)\n`;
  fs.writeFileSync(quarantineFile, content, "utf8");
}

function mergeJobIds(existing: unknown, added: string[]): string[] {
  const current = Array.isArray(existing) ? existing.map((value) => String(value)) : [];
  return [...new Set([...current, ...added])];
}

export function runVacationModeGuard(params?: {
  runtimeJobsPath?: string;
  quarantineDir?: string;
}): string {
  const config = loadVacationOpsConfig();
  const activeWindow = getActiveVacationWindow();
  if (!activeWindow) {
    return "NO_REPLY";
  }

  if (Date.now() >= Date.parse(activeWindow.end_at)) {
    const expired = disableVacationMode({ config, reason: "expired" });
    return expired.summaryText;
  }

  reconcileVacationMirror();

  const runtimeJobsPath = params?.runtimeJobsPath ?? RUNTIME_JOBS_PATH;
  const quarantineDir = params?.quarantineDir ?? QUARANTINE_DIR;
  const doc = readRuntimeJobs(runtimeJobsPath);
  if (!doc || !Array.isArray(doc.jobs)) {
    return "🏖️ Vacation mode actionable failure.\n- control_plane: runtime cron jobs unavailable";
  }

  const threshold = Math.max(1, Number(config.guard.quarantineAfterConsecutiveErrors || 1));
  const matchers = config.guard.fragileCronMatchers;
  const quarantined: string[] = [];
  const quarantinedIds: string[] = [];
  const now = Date.now();

  for (const job of doc.jobs) {
    if (job.enabled === false) continue;
    const name = String(job.name ?? "");
    const jobId = String(job.id ?? "");
    if (!name || !shouldMatch(name, matchers)) continue;
    if (!jobId) continue;
    const consecutiveErrors = Number(job.state?.consecutiveErrors ?? 0);
    if (consecutiveErrors < threshold) continue;

    job.enabled = false;
    job.updatedAtMs = now;
    quarantineJob(job, quarantineDir);
    quarantined.push(name);
    quarantinedIds.push(jobId);
  }

  if (!quarantinedIds.length) {
    return "NO_REPLY";
  }

  fs.writeFileSync(runtimeJobsPath, `${JSON.stringify(doc, null, 2)}\n`);
  updateVacationWindow(activeWindow.id, {
    stateSnapshot: {
      ...(activeWindow.state_snapshot ?? {}),
      paused_job_ids: mergeJobIds(activeWindow.state_snapshot?.paused_job_ids, quarantinedIds),
      quarantined_job_ids: mergeJobIds(activeWindow.state_snapshot?.quarantined_job_ids, quarantinedIds),
      last_guard_quarantine_at: new Date(now).toISOString(),
    },
  });
  reconcileVacationMirror();
  return [
    "🏖️ Vacation mode quarantined fragile cron jobs.",
    `- control_plane: disabled=${quarantined.length} jobs (${quarantined.slice(0, 4).join(", ")})`,
  ].join("\n");
}

function main(): void {
  console.log(runVacationModeGuard());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
