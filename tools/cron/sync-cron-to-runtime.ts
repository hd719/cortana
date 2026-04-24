#!/usr/bin/env npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeRuntimeCronState, normalizeRuntimeCronConfig, splitRuntimeOnlyJobs, stableCronSemanticDigest } from "../lib/runtime-cron-jobs.js";

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

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv: string[]): Args {
  let check = false;
  let json = false;
  let repoRoot = process.env.CORTANA_SOURCE_REPO ?? process.env.CORTANA_RUNTIME_REPO ?? DEFAULT_REPO_ROOT;
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
  const merged = mergeRuntimeCronState(repoConfig, runtimeConfig);
  const normalizedRuntimeConfig = normalizeRuntimeCronConfig(repoConfig, runtimeConfig);
  const { approvedManagedRuntimeOnlyJobs, unexpectedRuntimeOnlyJobs } = splitRuntimeOnlyJobs(repoConfig, runtimeConfig);

  const droppedRuntimeOnlyJobs = unexpectedRuntimeOnlyJobs
    .map((job) => String(job.id ?? ""))
    .filter(Boolean);
  const preservedManagedRuntimeOnlyJobs = approvedManagedRuntimeOnlyJobs
    .map((job) => String(job.id ?? ""))
    .filter(Boolean);

  const currentDigest = JSON.stringify(runtimeConfig);
  const mergedDigest = JSON.stringify(merged);
  const semanticMatch = stableCronSemanticDigest(repoConfig) === stableCronSemanticDigest(normalizedRuntimeConfig);
  const changed = currentDigest !== mergedDigest;

  const payload = {
    status: changed ? "updated" : "in_sync",
    repoFile,
    runtimeFile,
    changed,
    semanticMatch,
    droppedRuntimeOnlyJobs,
    preservedManagedRuntimeOnlyJobs,
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
