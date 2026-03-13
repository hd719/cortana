#!/usr/bin/env npx tsx

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type BacktestSummary = {
  schemaVersion: 1;
  runId: string;
  strategy: string;
  status: "success" | "failed";
  completedAt: string;
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

function pickPending(): { file: string; summary: BacktestSummary } | null {
  const candidates = listSummaries()
    .map((file) => ({ file, summary: loadSummary(file) }))
    .filter((item): item is { file: string; summary: BacktestSummary } => Boolean(item.summary))
    .filter((item) => item.summary.notifiedAt == null)
    .sort((a, b) => String(a.summary.completedAt).localeCompare(String(b.summary.completedAt)));

  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
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

function markNotified(file: string, summary: BacktestSummary): void {
  const updated = { ...summary, notifiedAt: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n");
  renameSync(tmp, file);
}

function main(): void {
  const picked = pickPending();
  if (!picked) {
    console.log("NO_PENDING_BACKTEST_SUMMARY");
    return;
  }

  const message = loadDurableMessage(picked.summary) || renderMessage(picked.summary);
  const proc = spawnSync(NOTIFY_BIN, [message, TARGET], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });

  if (proc.status !== 0) {
    const err = (proc.stderr || proc.stdout || "telegram delivery failed").trim();
    console.error(err);
    process.exit(proc.status ?? 1);
  }

  markNotified(picked.file, picked.summary);
  console.log(`NOTIFIED ${picked.summary.runId}`);
}

main();
