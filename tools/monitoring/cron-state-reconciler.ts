#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPsql } from "../lib/db.js";
import {
  classifyCronJobs,
  defaultRepoRoot,
  defaultRuntimeHome,
  loadCronEvidence,
  type ClassifiedCronJob,
  type RuntimeStateFileKind,
} from "./cron-state-evidence.js";

type Mode = "dry-run" | "apply";

type Args = {
  mode: Mode;
  json: boolean;
  writeReport: boolean;
  repoRoot: string;
  runtimeHome: string;
  sourceConfigPath?: string;
  runtimeConfigPath?: string;
  runtimeStatePath?: string;
  reportPath?: string;
};

type ReconcilerReport = {
  generatedAt: string;
  mode: Mode;
  sourceConfigPath: string;
  runtimeConfigPath: string;
  runtimeStatePath: string | null;
  runtimeStateFileKind: RuntimeStateFileKind;
  repairMode: "dry_run" | "json_plus_reload";
  summary: {
    total: number;
    healthy: number;
    disabled: number;
    staleErrorState: number;
    activeFailure: number;
    unknown: number;
    needsHuman: number;
    repaired: number;
  };
  jobs: Array<ClassifiedCronJob & {
    repairMode: "dry_run" | "json_plus_reload";
    requiresSchedulerReload: boolean;
    reloadVerified: boolean;
  }>;
  repair?: RepairResult;
};

type RepairResult = {
  repairedJobIds: string[];
  backupPath: string | null;
  statePath: string | null;
  reloadAttempted: boolean;
  reloadVerified: boolean;
  errors: string[];
};

type RepairOptions = {
  statePath: string;
  stateKind: RuntimeStateFileKind;
  jobs: ClassifiedCronJob[];
  reloadGateway?: () => boolean;
  verify?: () => ClassifiedCronJob[];
  nowMs?: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "dry-run",
    json: false,
    writeReport: false,
    repoRoot: defaultRepoRoot(),
    runtimeHome: defaultRuntimeHome(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.mode = "dry-run";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "--json") args.json = true;
    else if (arg === "--write-report") args.writeReport = true;
    else if (arg === "--repo-root" && argv[i + 1]) args.repoRoot = path.resolve(argv[++i]);
    else if (arg === "--runtime-home" && argv[i + 1]) args.runtimeHome = path.resolve(argv[++i]);
    else if (arg === "--source-config" && argv[i + 1]) args.sourceConfigPath = path.resolve(argv[++i]);
    else if (arg === "--runtime-config" && argv[i + 1]) args.runtimeConfigPath = path.resolve(argv[++i]);
    else if (arg === "--runtime-state" && argv[i + 1]) args.runtimeStatePath = path.resolve(argv[++i]);
    else if (arg === "--report-path" && argv[i + 1]) args.reportPath = path.resolve(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
  }

  return args;
}

function usage(): void {
  console.log(`Usage:
  npx tsx tools/monitoring/cron-state-reconciler.ts [--dry-run|--apply] [--json] [--write-report]

Options:
  --repo-root <path>       Source repo root. Defaults to CORTANA_SOURCE_REPO or cwd.
  --runtime-home <path>    Runtime home. Defaults to CORTANA_RUNTIME_HOME or $HOME.
  --source-config <path>   Override source config path.
  --runtime-config <path>  Override runtime cron jobs path.
  --runtime-state <path>   Override runtime cron state path.
  --report-path <path>     Override report artifact path.
`);
}

export function buildReport(args: Args, nowMs = Date.now()): ReconcilerReport {
  const evidence = loadCronEvidence({
    repoRoot: args.repoRoot,
    runtimeHome: args.runtimeHome,
    sourceConfigPath: args.sourceConfigPath,
    runtimeConfigPath: args.runtimeConfigPath,
    runtimeStatePath: args.runtimeStatePath,
  });
  const jobs = classifyCronJobs(evidence, { nowMs });
  return toReport(args.mode, evidence, jobs, null, nowMs);
}

export function repairRuntimeCronState(options: RepairOptions): RepairResult {
  const repairableJobs = options.jobs.filter((job) => job.repairable && job.classification === "stale_error_state");
  const result: RepairResult = {
    repairedJobIds: [],
    backupPath: null,
    statePath: options.statePath,
    reloadAttempted: false,
    reloadVerified: false,
    errors: [],
  };

  if (!repairableJobs.length) return result;
  if (options.stateKind === "missing") {
    result.errors.push("runtime_state_missing");
    return result;
  }

  const lockPath = `${options.statePath}.cron-state-reconciler.lock`;
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(lockFd, String(process.pid), "utf8");
    const original = JSON.parse(fs.readFileSync(options.statePath, "utf8"));
    const next = structuredClone(original);

    for (const job of repairableJobs) {
      const state = stateForMutation(next, options.stateKind, job.id);
      if (!state) {
        result.errors.push(`state_missing:${job.id}`);
        continue;
      }
      state.lastStatus = "ok";
      state.lastRunStatus = "ok";
      state.consecutiveErrors = 0;
      delete state.runningAtMs;
      result.repairedJobIds.push(job.id);
    }

    if (!result.repairedJobIds.length) return result;

    const stamp = new Date(options.nowMs ?? Date.now()).toISOString().replace(/[-:.TZ]/g, "");
    result.backupPath = `${options.statePath}.backup-cron-state-reconciler-${stamp}`;
    fs.copyFileSync(options.statePath, result.backupPath);
    writeJsonAtomic(options.statePath, next);

    result.reloadAttempted = true;
    const reloadOk = options.reloadGateway ? options.reloadGateway() : restartGateway();
    if (!reloadOk) {
      result.errors.push("scheduler_reload_failed");
      return result;
    }

    const verifiedJobs = options.verify ? options.verify() : [];
    const failedVerification = result.repairedJobIds.filter((id) => {
      const job = verifiedJobs.find((candidate) => candidate.id === id);
      return !job || job.classification === "stale_error_state" || job.lastRuntimeStatus === "error";
    });
    if (failedVerification.length) {
      result.errors.push(`post_reload_verification_failed:${failedVerification.join(",")}`);
      return result;
    }

    result.reloadVerified = true;
    return result;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  } finally {
    if (lockFd !== null) fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
  }
}

function toReport(
  mode: Mode,
  evidence: ReturnType<typeof loadCronEvidence>,
  jobs: ClassifiedCronJob[],
  repair: RepairResult | null,
  nowMs: number,
): ReconcilerReport {
  const summary = {
    total: jobs.length,
    healthy: jobs.filter((job) => job.classification === "healthy").length,
    disabled: jobs.filter((job) => job.classification === "disabled").length,
    staleErrorState: jobs.filter((job) => job.classification === "stale_error_state").length,
    activeFailure: jobs.filter((job) => job.classification === "active_failure").length,
    unknown: jobs.filter((job) => job.classification === "unknown").length,
    needsHuman: jobs.filter((job) => job.classification === "needs_human").length,
    repaired: repair?.repairedJobIds.length ?? 0,
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    mode,
    sourceConfigPath: evidence.sourceConfigPath,
    runtimeConfigPath: evidence.runtimeConfigPath,
    runtimeStatePath: evidence.runtimeStatePath,
    runtimeStateFileKind: evidence.runtimeStateFileKind,
    repairMode: mode === "apply" ? "json_plus_reload" : "dry_run",
    summary,
    jobs: jobs.map((job) => ({
      ...job,
      repairMode: mode === "apply" ? "json_plus_reload" : "dry_run",
      requiresSchedulerReload: mode === "apply" && job.repairable,
      reloadVerified: Boolean(repair?.reloadVerified && repair.repairedJobIds.includes(job.id)),
    })),
    ...(repair ? { repair } : {}),
  };
}

function stateForMutation(root: any, kind: RuntimeStateFileKind, id: string): Record<string, unknown> | null {
  if (kind === "jobs-state") {
    const state = root?.jobs?.[id]?.state;
    return state && typeof state === "object" ? state : null;
  }
  if (kind === "jobs-json" && Array.isArray(root?.jobs)) {
    const job = root.jobs.find((candidate: any) => candidate?.id === id);
    if (!job) return null;
    if (!job.state || typeof job.state !== "object") job.state = {};
    return job.state;
  }
  return null;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function restartGateway(): boolean {
  const proc = spawnSync("openclaw", ["gateway", "restart"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  return proc.status === 0;
}

function writeReport(filePath: string, report: ReconcilerReport): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomic(filePath, report);
}

function printHuman(report: ReconcilerReport): void {
  const actionable = report.jobs.filter((job) => (
    job.classification === "active_failure"
    || job.classification === "unknown"
    || job.classification === "needs_human"
    || job.classification === "stale_error_state"
  ));

  if (!actionable.length) {
    console.log("NO_REPLY");
    return;
  }

  const lines = ["Cron Runtime State Reconciler"];
  for (const job of actionable.slice(0, 10)) {
    lines.push(`- ${job.classification}: ${job.name} (${job.evidence})`);
  }
  if (actionable.length > 10) lines.push(`- ... ${actionable.length - 10} more`);
  console.log(lines.join("\n"));
}

function exitCode(report: ReconcilerReport): number {
  if (report.repair?.errors.length) return 1;
  return report.summary.activeFailure > 0 ? 1 : 0;
}

function logRepairEvents(report: ReconcilerReport): void {
  for (const id of report.repair?.repairedJobIds ?? []) {
    const job = report.jobs.find((candidate) => candidate.id === id);
    if (!job) continue;
    const metadata = JSON.stringify({
      job_id: job.id,
      classification: job.classification,
      evidence: job.evidence,
      before_status: "error",
      after_status: job.lastRuntimeStatus,
      repair_mode: report.repairMode,
      backup_path: report.repair?.backupPath,
    }).replace(/'/g, "''");
    const message = `Cron reconciler repaired stale metadata for ${job.name}`.replace(/'/g, "''");
    const sql = `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cron.reconciler.repaired', 'cron-state-reconciler', 'info', '${message}', '${metadata}'::jsonb);`;
    runPsql(sql);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  let report = buildReport(args, nowMs);

  if (args.mode === "apply") {
    const repair = report.runtimeStatePath
      ? repairRuntimeCronState({
        statePath: report.runtimeStatePath,
        stateKind: report.runtimeStateFileKind,
        jobs: report.jobs,
        verify: () => classifyCronJobs(loadCronEvidence({
          repoRoot: args.repoRoot,
          runtimeHome: args.runtimeHome,
          sourceConfigPath: args.sourceConfigPath,
          runtimeConfigPath: args.runtimeConfigPath,
          runtimeStatePath: args.runtimeStatePath,
        }), { nowMs: Date.now() }),
      })
      : {
        repairedJobIds: [],
        backupPath: null,
        statePath: null,
        reloadAttempted: false,
        reloadVerified: false,
        errors: ["runtime_state_missing"],
      };
    const evidence = loadCronEvidence({
      repoRoot: args.repoRoot,
      runtimeHome: args.runtimeHome,
      sourceConfigPath: args.sourceConfigPath,
      runtimeConfigPath: args.runtimeConfigPath,
      runtimeStatePath: args.runtimeStatePath,
    });
    report = toReport(args.mode, evidence, classifyCronJobs(evidence, { nowMs: Date.now() }), repair, Date.now());
    if (repair.repairedJobIds.length && !repair.errors.length) {
      try {
        logRepairEvents(report);
      } catch (error) {
        report.repair?.errors.push(`db_log_failed:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (args.writeReport) {
    writeReport(args.reportPath ?? path.join(args.runtimeHome, ".openclaw", "reports", "cron-state-reconciler", "latest.json"), report);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exitCode = exitCode(report);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
