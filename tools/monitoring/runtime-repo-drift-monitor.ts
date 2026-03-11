#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

type Check = {
  label: string;
  runtime: string;
  repo: string;
};

type Args = {
  autoPr: boolean;
  dryRun: boolean;
  repoRoot: string;
  base: string;
  branchPrefix: string;
};

type DriftAssessment = {
  check: Check;
  runtimeHash: string | null;
  repoHash: string | null;
  rawMismatch: boolean;
  actionable: boolean;
  reason: string;
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
]);

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const scriptRepoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

  let autoPr = process.env.DRIFT_AUTO_PR === "1";
  let dryRun = false;
  let repoRoot = process.env.DRIFT_REPO_ROOT || scriptRepoRoot;
  let base = process.env.DRIFT_BASE || "main";
  let branchPrefix = process.env.DRIFT_BRANCH_PREFIX || "chore/runtime-repo-drift-sync";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--auto-pr") autoPr = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo-root" && argv[i + 1]) repoRoot = argv[++i];
    else if (arg === "--base" && argv[i + 1]) base = argv[++i];
    else if (arg === "--branch-prefix" && argv[i + 1]) branchPrefix = argv[++i];
  }

  return { autoPr, dryRun, repoRoot: path.resolve(repoRoot), base, branchPrefix };
}

function digestBytes(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function digest(file: string): string | null {
  try {
    const b = fs.readFileSync(file);
    return crypto.createHash("sha256").update(b).digest("hex");
  } catch {
    return null;
  }
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
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

function normalizedDigest(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return digestBytes(JSON.stringify(stripVolatile(parsed)));
  } catch {
    return null;
  }
}

function assess(check: Check): DriftAssessment {
  const runtimeHash = digest(check.runtime);
  const repoHash = digest(check.repo);
  if (!runtimeHash || !repoHash) {
    return {
      check,
      runtimeHash,
      repoHash,
      rawMismatch: Boolean(runtimeHash !== repoHash),
      actionable: false,
      reason: "missing file(s)",
    };
  }

  const rawMismatch = runtimeHash !== repoHash;
  if (!rawMismatch) {
    return { check, runtimeHash, repoHash, rawMismatch: false, actionable: false, reason: "no drift" };
  }

  const runtimeNormalized = normalizedDigest(check.runtime);
  const repoNormalized = normalizedDigest(check.repo);
  if (runtimeNormalized && repoNormalized && runtimeNormalized === repoNormalized) {
    return {
      check,
      runtimeHash,
      repoHash,
      rawMismatch: true,
      actionable: false,
      reason: "runtime-only state drift suppressed",
    };
  }

  return {
    check,
    runtimeHash,
    repoHash,
    rawMismatch: true,
    actionable: true,
    reason: "actionable config drift",
  };
}

function syncAndOpenPr(assessments: DriftAssessment[], args: Args): string {
  const drifted = assessments.filter((a) => a.actionable);
  if (!drifted.length) return "";

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  const branch = `${args.branchPrefix}-${stamp}`;

  if (!args.dryRun) {
    run(`git checkout ${args.base}`, args.repoRoot);
    run(`git pull --ff-only origin ${args.base}`, args.repoRoot);
    run(`git checkout -b ${branch}`, args.repoRoot);
  }

  const copied: string[] = [];
  for (const assessment of drifted) {
    const rel = path.relative(args.repoRoot, assessment.check.repo);
    copied.push(rel);
    if (!args.dryRun) {
      fs.copyFileSync(assessment.check.runtime, assessment.check.repo);
      run(`git add ${JSON.stringify(rel)}`, args.repoRoot);
    }
  }

  if (args.dryRun) {
    return `DRY_RUN auto-pr: would create ${branch} with ${copied.join(", ")}`;
  }

  const hasChanges = run("git diff --cached --name-only", args.repoRoot);
  if (!hasChanges) {
    run("git checkout -", args.repoRoot);
    run(`git branch -D ${branch}`, args.repoRoot);
    return "auto-pr: no effective file changes after sync";
  }

  run(`git commit -m ${JSON.stringify("chore(config): sync actionable runtime drift to repo")}`, args.repoRoot);
  run(`git push -u origin ${branch}`, args.repoRoot);

  const title = "chore(config): sync actionable runtime drift to repo";
  const body = [
    "## Summary",
    "Automated sync of actionable runtime config drift into repo backup files.",
    "",
    "## Files",
    ...copied.map((f) => `- ${f}`),
    "",
    "Volatile runtime-only state fields were suppressed by runtime-repo-drift-monitor.ts.",
  ].join("\n");

  const prUrl = run(
    `gh pr create --base ${args.base} --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
    args.repoRoot,
  );

  return `auto-pr opened: ${prUrl}`;
}

function main() {
  const args = parseArgs();

  const checks: Check[] = [
    {
      label: "cron/jobs.json",
      runtime: path.join(os.homedir(), ".openclaw", "cron", "jobs.json"),
      repo: path.join(args.repoRoot, "config", "cron", "jobs.json"),
    },
    {
      label: "agent-profiles.json",
      runtime: path.join(os.homedir(), ".openclaw", "agent-profiles.json"),
      repo: path.join(args.repoRoot, "config", "agent-profiles.json"),
    },
  ];

  const assessments = checks.map(assess);
  const actionable = assessments.filter((a) => a.actionable);
  const suppressed = assessments.filter((a) => a.rawMismatch && !a.actionable && a.reason !== "missing file(s)");
  const missing = assessments.filter((a) => a.reason === "missing file(s)");

  if (!actionable.length && !missing.length) {
    console.log("NO_REPLY");
    return;
  }

  const lines = ["🧭 Runtime/Repo Drift Detected"];
  for (const item of actionable) lines.push(`- ${item.check.label}: ${item.reason}`);
  for (const item of missing) lines.push(`- ${item.check.label}: ${item.reason}`);
  if (suppressed.length) lines.push(`- suppressed runtime-only drift: ${suppressed.map((s) => s.check.label).join(", ")}`);

  if (args.autoPr && actionable.length) {
    try {
      const result = syncAndOpenPr(assessments, args);
      if (result) lines.push(`- ${result}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      lines.push(`- auto-pr failed: ${msg}`);
    }
  }

  console.log(lines.join("\n"));
}

main();
