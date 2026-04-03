#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runTradingPipelineDetailed, type PipelineSnapshot, type RunCommandOptions } from "./trading-pipeline";

export const BACKTESTER_CWD = "/Users/hd/Developer/cortana-external/backtester";
export const PYTHON_BIN = resolve(BACKTESTER_CWD, ".venv/bin/python");
const DEFAULT_SCAN_TIMEOUT_MS = 360_000;
const COMPACT_WATCHLIST_FULL_LIMIT = 7;
const COMPACT_WATCHLIST_TRUNCATED_LIMIT = 5;
const DEFAULT_CRON_RELIABILITY_ENV = {
  TRADING_SCAN_CHUNK_SIZE_CANSLIM: "20",
  TRADING_SCAN_CHUNK_PARALLELISM_CANSLIM: "2",
  TRADING_SCAN_CHUNK_SIZE_DIP: "20",
  TRADING_SCAN_CHUNK_PARALLELISM_DIP: "2",
} as const;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

export function resolveBacktesterCwd(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKTEST_CWD || BACKTESTER_CWD;
}

export function resolvePythonBin(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(resolveBacktesterCwd(env), ".venv/bin/python");
}

export function applyTradingCronReliabilityDefaults(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(DEFAULT_CRON_RELIABILITY_ENV)) {
    if (env[key] == null || env[key] === "") {
      env[key] = value;
    }
  }
  return env;
}

function getScanTimeoutMs(scriptName: string): number {
  const base = parsePositiveInt(process.env.TRADING_SCAN_TIMEOUT_MS, DEFAULT_SCAN_TIMEOUT_MS);
  if (scriptName === "canslim_alert.py") {
    return parsePositiveInt(process.env.TRADING_SCAN_TIMEOUT_MS_CANSLIM, base);
  }
  if (scriptName === "dipbuyer_alert.py") {
    return parsePositiveInt(process.env.TRADING_SCAN_TIMEOUT_MS_DIP, base);
  }
  return base;
}

export function boundedRunCommand(command: string, args: string[], options: RunCommandOptions = {}): string {
  const resolvedCommand = command === "python3" ? resolvePythonBin() : command;
  const scriptName = args[0] ?? "";
  const timeoutMs = parsePositiveInt(String(options.timeoutMs ?? ""), getScanTimeoutMs(scriptName));
  const strategyName =
    scriptName === "dipbuyer_alert.py" ? "Dip Buyer" : scriptName === "canslim_alert.py" ? "CANSLIM" : scriptName || command;

  const result = spawnSync(resolvedCommand, args, {
    cwd: resolveBacktesterCwd(),
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: timeoutMs,
  });

  if (result.error) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      throw new Error(`${strategyName} scan timed out after ${timeoutMs}ms`);
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${strategyName} scan failed`);
  }

  return (result.stdout || "").trim();
}

function trimLabel(line: string, prefix: string): string {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : line.trim();
}

function findLine(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix));
}

function parseCounts(line: string | undefined): { buy: number; watch: number; noBuy: number } {
  if (!line) return { buy: 0, watch: 0, noBuy: 0 };
  return {
    buy: Number(line.match(/BUY\s+(\d+)/i)?.[1] ?? 0),
    watch: Number(line.match(/WATCH\s+(\d+)/i)?.[1] ?? 0),
    noBuy: Number(line.match(/NO_BUY\s+(\d+)/i)?.[1] ?? 0),
  };
}

export type ParsedSignal = { ticker: string; score: number; action: "BUY" | "WATCH" | "NO_BUY"; section: string };

function parseSignalFragments(text: string, section: string): ParsedSignal[] {
  const signalRe = /•\s+([A-Z.\-]+)\s+\((\d+)\/\d+\)\s+→\s+(BUY|WATCH|NO_BUY)/g;
  const out: ParsedSignal[] = [];
  let match: RegExpExecArray | null;
  while ((match = signalRe.exec(text)) !== null) {
    out.push({
      ticker: match[1],
      score: Number(match[2]),
      action: match[3] as "BUY" | "WATCH" | "NO_BUY",
      section,
    });
  }
  return out;
}

export function collectSignalsDetailed(lines: string[], section: string): ParsedSignal[] {
  const startIndex = lines.findIndex((line) => line.startsWith(`${section}:`));
  if (startIndex === -1) return [];

  const out: ParsedSignal[] = [];
  // Known non-signal prefixes that appear between the section header and signal lines
  const skipPrefixes = [
    "Guardrails:",
    "Top blocker:",
    "Blockers:",
    "Watch names",
    "Correction gate:",
    "Leaders:",
    "👁️",
  ];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue; // skip blank lines within the section
    // Stop at the next major section header (but not skip-prefixed lines or signal lines)
    if (/^[A-Za-z][A-Za-z\s]+:/.test(line) && !line.includes("•") && !skipPrefixes.some((p) => line.startsWith(p))) break;
    // Stop at emoji-prefixed lines that aren't shadow mode or signal lines
    if (/^[⚠️📈]/.test(line)) break;
    if (!line.includes("•")) continue;
    // Handle pipe-separated multi-signal lines (e.g. "• ARES (10/12) → BUY | • APP (9/12) → BUY | ...")
    out.push(...parseSignalFragments(line, section));
  }

  const latest = new Map<string, ParsedSignal>();
  for (const signal of out) latest.set(signal.ticker, signal);

  const ordered: ParsedSignal[] = [];
  const seen = new Set<string>();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const signal = out[i];
    if (seen.has(signal.ticker)) continue;
    seen.add(signal.ticker);
    const finalSignal = latest.get(signal.ticker);
    if (finalSignal) ordered.push(finalSignal);
  }
  return ordered.reverse();
}

export function extractSignalsFromPipelineReport(report: string): {
  canslim: ParsedSignal[];
  dipBuyer: ParsedSignal[];
  all: ParsedSignal[];
} {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const canslim = collectSignalsDetailed(lines, "CANSLIM");
  const dipBuyer = collectSignalsDetailed(lines, "Dip Buyer");
  const seen = new Set<string>();
  const all = [...canslim, ...dipBuyer].filter((signal) => {
    const key = `${signal.section}:${signal.ticker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { canslim, dipBuyer, all };
}

export function buildCronAlertFromPipelineReport(report: string): string {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const decision = trimLabel(findLine(lines, "Decision:") ?? "Decision: unavailable", "Decision:");
  const confidenceRisk = trimLabel(findLine(lines, "Confidence:") ?? "Confidence: unavailable", "Confidence:");
  const confidence = confidenceRisk.match(/^([0-9.]+)/)?.[1] ?? "unavailable";
  const risk = confidenceRisk.match(/Risk:\s*([A-Z]+)/i)?.[1]?.toUpperCase() ?? "UNKNOWN";
  const regimeRaw = trimLabel(findLine(lines, "Regime/Gates:") ?? "Regime/Gates: unavailable", "Regime/Gates:");
  const inCorrection = /correction=YES/i.test(regimeRaw) || /\bcorrection\b/i.test(regimeRaw);

  const summaryCounts = parseCounts(findLine(lines, "Summary:"));
  const canslimCounts = parseCounts(findLine(lines, "CANSLIM:"));
  const dipCounts = parseCounts(findLine(lines, "Dip Buyer:"));

  const { canslim: canslimSignals, dipBuyer: dipSignals } = extractSignalsFromPipelineReport(report);
  const watchDip = dipSignals.filter((s) => s.action === "WATCH");
  const watchCanslim = canslimSignals.filter((s) => s.action === "WATCH");

  const buySignals = [...canslimSignals, ...dipSignals].filter((s) => s.action === "BUY");
  const focusSignal = buySignals[0] ?? [...dipSignals, ...canslimSignals].find((s) => s.action !== "NO_BUY");
  const focusSources = focusSignal
    ? [
      canslimSignals.some((s) => s.ticker === focusSignal.ticker) ? "CANSLIM" : "",
      dipSignals.some((s) => s.ticker === focusSignal.ticker) ? "Dip Buyer" : "",
    ].filter(Boolean)
    : [];

  const blockerTelemetry = findLine(lines, "Blocker telemetry:");
  const guardrailCount = blockerTelemetry?.match(/(\d+)/)?.[1] ?? "0";
  const diagnostics = findLine(lines, "Diagnostics:");
  const relatedDetections = diagnostics?.match(/candidates evaluated\s+(\d+)/i)?.[1] ?? "0";
  const calibration = trimLabel(findLine(lines, "Calibration:") ?? "", "Calibration:");

  const formatWatchEntry = (signal: ParsedSignal): string => `${signal.ticker} ${signal.score}/12`;
  const renderWatchlist = (
    section: "Dip Buyer" | "CANSLIM",
    items: ParsedSignal[],
    declaredWatchCount: number,
  ): { title: string; body: string } => {
    const availableCount = items.length;
    const totalCount = declaredWatchCount > 0 ? declaredWatchCount : availableCount;
    const hasFullList = declaredWatchCount <= 0 || availableCount >= declaredWatchCount;
    const collapsedFullList = hasFullList && totalCount > COMPACT_WATCHLIST_FULL_LIMIT;
    const title = !hasFullList
      ? `👀 ${section} Watchlist (showing ${availableCount} of ${totalCount}):`
      : collapsedFullList
        ? `👀 ${section} Watchlist (top ${Math.min(totalCount, COMPACT_WATCHLIST_TRUNCATED_LIMIT)} of ${totalCount}):`
        : `👀 ${section} Watchlist (${totalCount}):`;

    if (!availableCount) return { title, body: " —" };

    if (hasFullList && totalCount <= COMPACT_WATCHLIST_FULL_LIMIT) {
      return { title, body: ` ${items.map(formatWatchEntry).join(" · ")}` };
    }

    if (hasFullList) {
      const shown = items.slice(0, COMPACT_WATCHLIST_TRUNCATED_LIMIT).map(formatWatchEntry).join(" · ");
      const remaining = totalCount - Math.min(totalCount, COMPACT_WATCHLIST_TRUNCATED_LIMIT);
      return { title, body: remaining > 0 ? ` ${shown} [+${remaining} more]` : ` ${shown}` };
    }

    const listed = items.map(formatWatchEntry).join(" · ");
    const missing = Math.max(totalCount - availableCount, 0);
    return { title, body: missing > 0 ? ` ${listed} [partial: ${missing} unavailable]` : ` ${listed}` };
  };
  const dipWatchlist = renderWatchlist("Dip Buyer", watchDip, dipCounts.watch);
  const canslimWatchlist = renderWatchlist("CANSLIM", watchCanslim, canslimCounts.watch);

  const messageLines = [
    "📈 Trading Advisor — Market Snapshot",
    "⚡ P1 High | Action Now",
    "",
    `🎯 Decision: ${decision} | Confidence: ${confidence} | Risk: ${risk}`,
    inCorrection ? `🔴 Regime: CORRECTION — no new positions` : `🟢 Regime: ${regimeRaw}`,
    "",
    "┌ Summary ─────────────────────┐",
    `│ BUY ${summaryCounts.buy} │ WATCH ${summaryCounts.watch} │ NO_BUY ${summaryCounts.noBuy} │`,
    "├──────────────────────────────┤",
    `│ CANSLIM: BUY ${canslimCounts.buy} · WATCH ${canslimCounts.watch} │`,
    `│ Dip Buyer: BUY ${dipCounts.buy} · WATCH ${dipCounts.watch} │`,
    "└──────────────────────────────┘",
    "",
    focusSignal
      ? `🔥 Focus: ${focusSignal.ticker} — ${focusSignal.action}${focusSources.length ? ` (${focusSources.join(" + ")})` : ""}`
      : "🔥 Focus: unavailable",
    calibration ? `🧪 Calibration: ${calibration.replace(/^fresh\b/i, "FRESH").replace(/^stale\b/i, "STALE")}` : undefined,
    "",
    dipWatchlist.title,
    dipWatchlist.body,
    "",
    canslimWatchlist.title,
    canslimWatchlist.body,
    "",
    `🛡️ Guardrail blocks/downgrades: ${guardrailCount}`,
    `🔎 Related detections: ${relatedDetections}`,
  ];

  return messageLines.filter(Boolean).join("\n").trim();
}

export function buildCronAlertFromPipelineSnapshot(snapshot: PipelineSnapshot): string {
  const summaryCounts = snapshot.summary;
  const canslimCounts = snapshot.strategies.canslim;
  const dipCounts = snapshot.strategies.dipBuyer;

  const watchDip = dipCounts.signals.filter((s) => s.action === "WATCH").map((signal) => ({
    ticker: signal.ticker,
    score: signal.score ?? 0,
    action: signal.action,
    section: "Dip Buyer" as const,
  }));
  const watchCanslim = canslimCounts.signals.filter((s) => s.action === "WATCH").map((signal) => ({
    ticker: signal.ticker,
    score: signal.score ?? 0,
    action: signal.action,
    section: "CANSLIM" as const,
  }));

  const buySignals = [...canslimCounts.signals, ...dipCounts.signals].filter((s) => s.action === "BUY");
  const focusSignal =
    buySignals[0] ?? [...dipCounts.signals, ...canslimCounts.signals].find((s) => s.action !== "NO_BUY");
  const focusSources = focusSignal
    ? [
        canslimCounts.signals.some((s) => s.ticker === focusSignal.ticker) ? "CANSLIM" : "",
        dipCounts.signals.some((s) => s.ticker === focusSignal.ticker) ? "Dip Buyer" : "",
      ].filter(Boolean)
    : [];

  const calibration = snapshot.calibration
    ? `${snapshot.calibration.status} | settled ${snapshot.calibration.settledCandidates}${snapshot.calibration.reason && snapshot.calibration.status === "stale" ? ` | ${snapshot.calibration.reason}` : ""}`
    : "";

  const formatWatchEntry = (signal: { ticker: string; score: number }): string => `${signal.ticker} ${signal.score}/12`;
  const renderWatchlist = (
    section: "Dip Buyer" | "CANSLIM",
    items: Array<{ ticker: string; score: number }>,
    declaredWatchCount: number,
  ): { title: string; body: string } => {
    const availableCount = items.length;
    const totalCount = declaredWatchCount > 0 ? declaredWatchCount : availableCount;
    const hasFullList = declaredWatchCount <= 0 || availableCount >= declaredWatchCount;
    const collapsedFullList = hasFullList && totalCount > COMPACT_WATCHLIST_FULL_LIMIT;
    const title = !hasFullList
      ? `👀 ${section} Watchlist (showing ${availableCount} of ${totalCount}):`
      : collapsedFullList
        ? `👀 ${section} Watchlist (top ${Math.min(totalCount, COMPACT_WATCHLIST_TRUNCATED_LIMIT)} of ${totalCount}):`
        : `👀 ${section} Watchlist (${totalCount}):`;

    if (!availableCount) return { title, body: " —" };

    if (hasFullList && totalCount <= COMPACT_WATCHLIST_FULL_LIMIT) {
      return { title, body: ` ${items.map(formatWatchEntry).join(" · ")}` };
    }

    if (hasFullList) {
      const shown = items.slice(0, COMPACT_WATCHLIST_TRUNCATED_LIMIT).map(formatWatchEntry).join(" · ");
      const remaining = totalCount - Math.min(totalCount, COMPACT_WATCHLIST_TRUNCATED_LIMIT);
      return { title, body: remaining > 0 ? ` ${shown} [+${remaining} more]` : ` ${shown}` };
    }

    const listed = items.map(formatWatchEntry).join(" · ");
    const missing = Math.max(totalCount - availableCount, 0);
    return { title, body: missing > 0 ? ` ${listed} [partial: ${missing} unavailable]` : ` ${listed}` };
  };
  const dipWatchlist = renderWatchlist("Dip Buyer", watchDip, dipCounts.watch);
  const canslimWatchlist = renderWatchlist("CANSLIM", watchCanslim, canslimCounts.watch);

  const messageLines = [
    "📈 Trading Advisor — Market Snapshot",
    "⚡ P1 High | Action Now",
    "",
    `🎯 Decision: ${snapshot.decision} | Confidence: ${snapshot.confidence.toFixed(2)} | Risk: ${snapshot.risk}`,
    snapshot.correctionMode ? `🔴 Regime: CORRECTION — no new positions` : `🟢 Regime: ${snapshot.regimeGates}`,
    "",
    "┌ Summary ─────────────────────┐",
    `│ BUY ${summaryCounts.buy} │ WATCH ${summaryCounts.watch} │ NO_BUY ${summaryCounts.noBuy} │`,
    "├──────────────────────────────┤",
    `│ CANSLIM: BUY ${canslimCounts.buy} · WATCH ${canslimCounts.watch} │`,
    `│ Dip Buyer: BUY ${dipCounts.buy} · WATCH ${dipCounts.watch} │`,
    "└──────────────────────────────┘",
    "",
    focusSignal
      ? `🔥 Focus: ${focusSignal.ticker} — ${focusSignal.action}${focusSources.length ? ` (${focusSources.join(" + ")})` : ""}`
      : "🔥 Focus: unavailable",
    calibration ? `🧪 Calibration: ${calibration.replace(/^fresh\b/i, "FRESH").replace(/^stale\b/i, "STALE")}` : undefined,
    "",
    dipWatchlist.title,
    dipWatchlist.body,
    "",
    canslimWatchlist.title,
    canslimWatchlist.body,
    "",
    `🛡️ Guardrail blocks/downgrades: ${snapshot.guardrailCount}`,
    `🔎 Related detections: ${snapshot.relatedDetections}`,
  ];

  return messageLines.filter(Boolean).join("\n").trim();
}

async function main(): Promise<void> {
  try {
    applyTradingCronReliabilityDefaults();
    const { snapshot } = await runTradingPipelineDetailed({ runCommand: boundedRunCommand });
    console.log(buildCronAlertFromPipelineSnapshot(snapshot));
  } catch (error) {
    console.log(`📈 Trading Advisor - Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
