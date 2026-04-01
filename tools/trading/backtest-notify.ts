#!/usr/bin/env npx tsx

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

type BacktestSummary = {
  schemaVersion: 1;
  schema_version?: 1;
  runId: string;
  run_id?: string;
  strategy: string;
  status: "success" | "failed";
  completedAt: string;
  finalizedAt?: string;
  notifiedAt: string | null;
  metrics?: Record<string, string | number | boolean | null>;
  artifacts: {
    directory: string;
    summary: string;
    log: string;
    stdout?: string;
    message?: string;
  };
  error?: {
    message: string;
    exitCode: number | null;
    signal: string | null;
  };
};

const DEFAULT_ROOT = path.join(process.cwd(), "var", "backtests");
const RUNS_DIR = path.join(process.env.BACKTEST_ROOT_DIR || DEFAULT_ROOT, "runs");
const NOTIFY_BIN = process.env.BACKTEST_NOTIFY_BIN || path.join(process.cwd(), "tools", "notifications", "telegram-delivery-guard.sh");
const TARGET = process.env.BACKTEST_NOTIFY_TARGET || "8171372724";
const INCLUDE_FAILURES = process.env.BACKTEST_NOTIFY_INCLUDE_FAILURES === "1";
const TRADING_ALERT_TYPE = "trading_market_snapshot";
const TRADING_SYSTEM = "Trading Advisor";
const TRADING_OWNER = "monitor";
const TRADING_ACTION_NEEDED = "now";
const TRADING_SOURCE_AGENT = "cron-market";

function listSummaries(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .map((entry) => path.join(RUNS_DIR, entry, "summary.json"))
    .filter((p) => existsSync(p))
    .sort();
}

function loadSummary(file: string): BacktestSummary | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BacktestSummary;
  } catch {
    return null;
  }
}

export type SummaryCandidate = { file: string; summary: BacktestSummary };

export function pickPendingFromCandidates(
  candidates: SummaryCandidate[],
  options: { includeFailures?: boolean } = {},
): SummaryCandidate | null {
  const includeFailures = options.includeFailures ?? false;
  const latest = [...candidates].sort((a, b) =>
    String(a.summary.completedAt).localeCompare(String(b.summary.completedAt)),
  ).pop();

  if (!latest) return null;
  if (latest.summary.notifiedAt != null) return null;
  if (!includeFailures && latest.summary.status !== "success") return null;
  return latest;
}

function describeFailedPendingSummary(candidate: SummaryCandidate): string {
  const summaryText = (
    candidate.summary.error?.summary
    || candidate.summary.error?.message
    || "latest backtest run failed"
  ).replace(/\s+/g, " ").trim().slice(0, 220);
  const summaryPath = candidate.summary.artifacts.summary || candidate.file;
  return `FAILED_PENDING_BACKTEST_SUMMARY run_id=${candidate.summary.runId} summary_path=${summaryPath} summary=${summaryText}`;
}

export function describePendingStateFromCandidates(
  candidates: SummaryCandidate[],
  options: { includeFailures?: boolean } = {},
): string {
  const includeFailures = options.includeFailures ?? false;
  const latest = [...candidates].sort((a, b) =>
    String(a.summary.completedAt).localeCompare(String(b.summary.completedAt)),
  ).pop();

  if (!latest) return "NO_PENDING_BACKTEST_SUMMARY";
  if (latest.summary.notifiedAt != null) return "NO_PENDING_BACKTEST_SUMMARY";
  if (!includeFailures && latest.summary.status !== "success") return describeFailedPendingSummary(latest);
  return "NO_PENDING_BACKTEST_SUMMARY";
}

function loadCandidates(): SummaryCandidate[] {
  return listSummaries()
    .map((file) => ({ file, summary: loadSummary(file) }))
    .filter((item): item is { file: string; summary: BacktestSummary } => Boolean(item.summary));
}

function pickPending(): { file: string; summary: BacktestSummary } | null {
  return pickPendingFromCandidates(loadCandidates(), { includeFailures: INCLUDE_FAILURES });
}

function compactMetrics(metrics: Record<string, string | number | boolean | null> | undefined): string {
  if (!metrics) return "";
  const preferred = ["return", "return_pct", "sharpe", "win_rate", "max_drawdown", "trades"];
  const used = preferred.filter((key) => key in metrics);
  const keys = used.length ? used : Object.keys(metrics).slice(0, 6);
  return keys.map((key) => `${key}=${String(metrics[key])}`).join(" | ");
}

function renderMessage(summary: BacktestSummary): string {
  if (summary.status === "success") {
    const metrics = compactMetrics(summary.metrics);
    return [
      `📈 Backtest - ${summary.strategy}`,
      `Run ${summary.runId} finished successfully.`,
      metrics || "Metrics unavailable.",
      `Artifacts: ${summary.artifacts.directory}`,
    ].join("\n");
  }

  return [
    `⚠️ Backtest - ${summary.strategy}`,
    `Run ${summary.runId} failed.`,
    (summary.error?.message || "Unknown error").slice(0, 500),
    `Log: ${summary.artifacts.log}`,
  ].join("\n");
}

function loadDurableMessage(summary: BacktestSummary): string | null {
  for (const artifact of [summary.artifacts.message, summary.artifacts.stdout]) {
    if (!artifact || !existsSync(artifact)) continue;
    const value = readFileSync(artifact, "utf8").trim();
    if (value) return value;
  }
  return null;
}

export function buildNotifyArgs(summary: BacktestSummary, message: string): string[] {
  return [
    message,
    TARGET,
    "",
    TRADING_ALERT_TYPE,
    `${TRADING_ALERT_TYPE}:${summary.runId}`,
    "high",
    TRADING_OWNER,
    TRADING_SYSTEM,
    TRADING_ACTION_NEEDED,
    TRADING_SOURCE_AGENT,
  ];
}

function markNotified(file: string, summary: BacktestSummary): void {
  const updated = { ...summary, notifiedAt: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n");
  renameSync(tmp, file);
}

function main(): void {
  const picked = pickPending();
  if (!picked) {
    console.log(describePendingStateFromCandidates(loadCandidates(), { includeFailures: INCLUDE_FAILURES }));
    return;
  }

  const message = loadDurableMessage(picked.summary) || renderMessage(picked.summary);
  const proc = spawnSync(NOTIFY_BIN, buildNotifyArgs(picked.summary, message), {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });

  const stdout = (proc.stdout || "").trim();
  const stderr = (proc.stderr || "").trim();
  const parsedLine = stdout.split(/\r?\n/).filter(Boolean).pop();
  let parsed: any = null;
  try {
    parsed = parsedLine ? JSON.parse(parsedLine) : null;
  } catch {
    parsed = null;
  }
  const mode = parsed?.mode ?? null;
  const delivered = parsed?.delivered === true && mode === "sent";

  if ((proc.status ?? 1) !== 0) {
    const err = (stderr || stdout || "telegram delivery failed").trim();
    console.error(err);
    process.exit((proc.status ?? 1) || 1);
  }

  if (!delivered) {
    console.error(`telegram delivery not confirmed (mode=${mode || "unknown"})`);
    return;
  }

  markNotified(picked.file, picked.summary);
  console.log(`NOTIFIED ${picked.summary.runId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
