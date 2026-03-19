#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Job = {
  id?: string;
  name?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; everyMs?: number };
  state?: {
    consecutiveErrors?: number;
    lastDurationMs?: number;
    lastRunAtMs?: number;
    nextRunAtMs?: number;
    lastStatus?: string;
    lastRunStatus?: string;
    lastDeliveryStatus?: string;
  };
  payload?: { timeoutSeconds?: number };
};

const runtimeJobsPath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");

const KNOWN_NOISY_JOB_NAMES = new Set([
  "📈 Stock Market Brief (daily)",
  "📉 Dip Buyer Alert Scan (market sessions)",
]);

const CRITICAL_JOB_NAMES = new Set([
  "☀️ Morning brief (Hamel)",
  "📅 Calendar reminders → Telegram (ALL calendars)",
  "⏰ Apple Reminders alerts → Telegram (Monitor)",
  "🔧 Fitness service healthcheck",
  "📏 Cron SLO Monitor (daily)",
]);

function readJobs(): Job[] {
  try {
    const raw = fs.readFileSync(runtimeJobsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

function scheduleLikelyDue(job: Job, now: number): boolean {
  const next = Number(job?.state?.nextRunAtMs || 0);
  if (!next) return false;
  return now - next > 30 * 60 * 1000; // >30m overdue
}

function isKnownNoisy(job: Job): boolean {
  const name = job.name || "";
  return KNOWN_NOISY_JOB_NAMES.has(name);
}

function isCritical(job: Job): boolean {
  const name = job.name || "";
  return CRITICAL_JOB_NAMES.has(name);
}

function isNearTimeout(job: Job): boolean {
  const d = Number(job?.state?.lastDurationMs || 0);
  const timeoutMs = Number(job?.payload?.timeoutSeconds || 0) * 1000;
  return timeoutMs > 0 && d > timeoutMs * 0.8;
}

function hasDeliveryProblem(job: Job): boolean {
  const status = String(job?.state?.lastDeliveryStatus || "").toLowerCase();
  return status === "error" || status === "failed";
}

function label(job: Job): string {
  return job.name || job.id || "unknown";
}

function top(arr: Job[]): string {
  return arr.slice(0, 5).map(label).join(", ");
}

function main() {
  const now = Date.now();
  const jobs = readJobs().filter((j) => j.enabled !== false);
  if (!jobs.length) {
    console.log("NO_REPLY");
    return;
  }

  const erroring = jobs.filter((j) => Number(j?.state?.consecutiveErrors || 0) >= 2);
  const missed = jobs.filter((j) => scheduleLikelyDue(j, now));
  const nearTimeoutAll = jobs.filter(isNearTimeout);

  const actionableErroring = erroring.filter((j) => !isKnownNoisy(j));
  const noisyErroring = erroring.filter(isKnownNoisy);
  const actionableMissed = missed.filter((j) => !isKnownNoisy(j));
  const noisyMissed = missed.filter(isKnownNoisy);
  const actionableNearTimeout = nearTimeoutAll.filter((j) => {
    if (isKnownNoisy(j)) return false;
    const consecutiveErrors = Number(j?.state?.consecutiveErrors || 0);
    return isCritical(j) || consecutiveErrors >= 1 || hasDeliveryProblem(j);
  });

  if (!actionableErroring.length && !actionableNearTimeout.length && !actionableMissed.length) {
    console.log("NO_REPLY");
    return;
  }

  const lines = ["📏 Cron SLO Monitor", "Actionable thresholds exceeded:"];
  if (actionableErroring.length) lines.push(`- consecutiveErrors>=2: ${actionableErroring.length} (${top(actionableErroring)})`);
  if (actionableNearTimeout.length) lines.push(`- near-timeout runs (>80% timeout, critical/degrading only): ${actionableNearTimeout.length} (${top(actionableNearTimeout)})`);
  if (actionableMissed.length) lines.push(`- likely missed schedules (>30m overdue): ${actionableMissed.length} (${top(actionableMissed)})`);

  const watchlist: string[] = [];
  if (noisyErroring.length) watchlist.push(`${noisyErroring.length} known legacy job(s) still erroring (${top(noisyErroring)})`);
  if (noisyMissed.length) watchlist.push(`${noisyMissed.length} known legacy job(s) look overdue (${top(noisyMissed)})`);
  if (watchlist.length) lines.push(`- watchlist: ${watchlist.join('; ')}`);

  console.log(lines.join("\n"));
}

main();
