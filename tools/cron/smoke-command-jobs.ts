#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCommandJobSpec } from "./control-plane.js";

type CronJob = Record<string, unknown>;
type CronConfig = { jobs?: CronJob[] };

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNNER = path.join(DEFAULT_REPO_ROOT, "tools", "cron", "command-job-runner.ts");

function parseArgs(argv: string[]): { repoRoot: string; jobIds: string[]; noAlert: boolean; json: boolean } {
  let repoRoot = process.env.CORTANA_SOURCE_REPO ?? DEFAULT_REPO_ROOT;
  const jobIds: string[] = [];
  let noAlert = true;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-root" && argv[i + 1]) repoRoot = path.resolve(argv[++i]);
    else if (arg === "--job-id" && argv[i + 1]) jobIds.push(argv[++i]);
    else if (arg === "--alert") noAlert = false;
    else if (arg === "--no-alert") noAlert = true;
    else if (arg === "--json") json = true;
  }

  return { repoRoot, jobIds, noAlert, json };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const jobsFile = path.join(args.repoRoot, "config", "cron", "jobs.json");
  const config = JSON.parse(fs.readFileSync(jobsFile, "utf8")) as CronConfig;
  const allJobs = Array.isArray(config.jobs) ? config.jobs : [];
  const selected = allJobs.filter((job) => {
    const id = String(job.id ?? "");
    if (args.jobIds.length > 0 && !args.jobIds.includes(id)) return false;
    return Boolean(getCommandJobSpec(job));
  });

  const rows = selected.map((job) => {
    const id = String(job.id ?? "");
    const proc = spawnSync(
      "npx",
      ["tsx", RUNNER, "--job-id", id, "--jobs-file", jobsFile, args.noAlert ? "--no-alert" : "--alert"],
      { cwd: args.repoRoot, encoding: "utf8", timeout: 900000 },
    );
    return {
      id,
      name: String(job.name ?? ""),
      status: proc.status ?? 1,
      ok: (proc.status ?? 1) === 0,
      stdout: (proc.stdout ?? "").trim(),
      stderr: (proc.stderr ?? "").trim(),
    };
  });

  const payload = {
    ok: rows.every((row) => row.ok),
    count: rows.length,
    rows,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (payload.ok) {
    console.log("NO_REPLY");
  } else {
    for (const row of rows.filter((item) => !item.ok)) {
      console.log(`${row.id}: failed status=${row.status} ${row.stdout || row.stderr}`);
    }
  }

  process.exit(payload.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
