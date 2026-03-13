#!/usr/bin/env npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CronJob = Record<string, unknown>;
type CronConfig = {
  jobs?: CronJob[];
  [key: string]: unknown;
};

type Args = {
  check: boolean;
  json: boolean;
  repoRoot: string;
  runtimeHome: string;
};

const VOLATILE_KEYS = new Set([
  "state",
  "updatedAtMs",
  "lastRunAtMs",
  "nextRunAtMs",
  "lastStatus",
  "lastRunStatus",
  "lastDurationMs",
  "lastDeliveryStatus",
  "lastDelivered",
  "consecutiveErrors",
  "reconciledAt",
  "reconciledReason",
  "runningAtMs",
  "lastError",
]);

function parseArgs(argv: string[]): Args {
  let check = false;
  let json = false;
  let repoRoot = process.env.CORTANA_RUNTIME_REPO ?? process.cwd();
  let runtimeHome = process.env.CORTANA_RUNTIME_HOME ?? os.homedir();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--json") json = true;
    else if (arg === "--repo-root" && argv[i + 1]) repoRoot = path.resolve(argv[++i]);
    else if (arg === "--runtime-home" && argv[i + 1]) runtimeHome = path.resolve(argv[++i]);
  }

  return { check, json, repoRoot, runtimeHome };
}

function readJson(filePath: string): CronConfig {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as CronConfig;
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = stripVolatile(inner);
  }
  return out;
}

function mergeRuntimeState(repoConfig: CronConfig, runtimeConfig: CronConfig): CronConfig {
  const repoJobs = Array.isArray(repoConfig.jobs) ? repoConfig.jobs : [];
  const runtimeJobs = Array.isArray(runtimeConfig.jobs) ? runtimeConfig.jobs : [];
  const runtimeById = new Map(runtimeJobs.map((job) => [String(job.id ?? ""), job]));

  const mergedJobs = repoJobs.map((repoJob) => {
    const jobId = String(repoJob.id ?? "");
    const runtimeJob = runtimeById.get(jobId);
    if (!runtimeJob) return repoJob;

    const merged: CronJob = { ...repoJob };
    for (const [key, value] of Object.entries(runtimeJob)) {
      if (!VOLATILE_KEYS.has(key)) continue;
      merged[key] = value;
    }
    return merged;
  });

  return { ...repoConfig, jobs: mergedJobs };
}

function stableDigest(value: unknown): string {
  return JSON.stringify(stripVolatile(value));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoFile = path.join(args.repoRoot, "config", "cron", "jobs.json");
  const runtimeFile = path.join(args.runtimeHome, ".openclaw", "cron", "jobs.json");

  if (!fs.existsSync(repoFile)) {
    throw new Error(`repo jobs file missing: ${repoFile}`);
  }
  if (!fs.existsSync(runtimeFile)) {
    throw new Error(`runtime jobs file missing: ${runtimeFile}`);
  }

  const repoConfig = readJson(repoFile);
  const runtimeConfig = readJson(runtimeFile);
  const merged = mergeRuntimeState(repoConfig, runtimeConfig);

  const repoJobs = Array.isArray(repoConfig.jobs) ? repoConfig.jobs : [];
  const runtimeJobs = Array.isArray(runtimeConfig.jobs) ? runtimeConfig.jobs : [];
  const repoIds = new Set(repoJobs.map((job) => String(job.id ?? "")));
  const droppedRuntimeOnlyJobs = runtimeJobs
    .map((job) => String(job.id ?? ""))
    .filter((jobId) => jobId && !repoIds.has(jobId));

  const currentDigest = JSON.stringify(runtimeConfig);
  const mergedDigest = JSON.stringify(merged);
  const semanticMatch = stableDigest(repoConfig) === stableDigest(runtimeConfig);
  const changed = currentDigest !== mergedDigest;

  const payload = {
    status: changed ? "updated" : "in_sync",
    repoFile,
    runtimeFile,
    changed,
    semanticMatch,
    droppedRuntimeOnlyJobs,
  };

  if (args.check) {
    if (args.json) {
      console.log(JSON.stringify(payload));
      return;
    }
    console.log(changed ? "OUT_OF_SYNC" : "IN_SYNC");
    return;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }

  if (args.json) {
    console.log(JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}

main();
