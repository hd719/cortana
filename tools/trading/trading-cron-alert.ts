#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runTradingPipeline, type RunCommandOptions } from "./trading-pipeline";

export const BACKTESTER_CWD = "/Users/hd/Developer/cortana-external/backtester";
export const PYTHON_BIN = resolve(BACKTESTER_CWD, ".venv/bin/python");
const DEFAULT_SCAN_TIMEOUT_MS = 360_000;
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

type ParsedSignal = { ticker: string; score: number; action: "BUY" | "WATCH" | "NO_BUY"; section: string };

function collectSignalsDetailed(lines: string[], section: string): ParsedSignal[] {
  const startIndex = lines.findIndex((line) => line.startsWith(`${section}:`));
  if (startIndex === -1) return [];

  const out: ParsedSignal[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    if (/^[A-Za-z][A-Za-z\s]+:/.test(line) && !line.startsWith("• ")) break;
    if (!line.startsWith("• ")) continue;
    const match = line.match(/^•\s+([A-Z.\-]+)\s+\((\d+)\/\d+\)\s+→\s+(BUY|WATCH|NO_BUY)/);
    if (!match) continue;
    out.push({
      ticker: match[1],
      score: Number(match[2]),
      action: match[3] as "BUY" | "WATCH" | "NO_BUY",
      section,
    });
  }

  return out;
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

  const canslimSignals = collectSignalsDetailed(lines, "CANSLIM");
  const dipSignals = collectSignalsDetailed(lines, "Dip Buyer");
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

  const formatWatch = (items: ParsedSignal[]): string => {
    if (!items.length) return " —";
    const shown = items.slice(0, 3).map((s) => `${s.ticker} ${s.score}/12`).join(" · ");
    const missing = items.length - 3;
    return missing > 0 ? ` ${shown}\n [+ ${missing} missing — bug]` : ` ${shown}`;
  };

  const messageLines = [
    "📈 Trading Advisor — Market Snapshot",
    "⚡ P1 High | Action Now",
    "",
    `🎯 Decision: ${decision} | Confidence: ${confidence} | Risk: ${risk}`,
    inCorrection ? "🔴 Regime: CORRECTION — no new positions | unavailable" : `🟢 Regime: ${regimeRaw}`,
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
    "",
    `👀 Dip Buyer Watchlist (${watchDip.length}):`,
    formatWatch(watchDip),
    "",
    `👀 CANSLIM Watchlist (${watchCanslim.length}):`,
    formatWatch(watchCanslim),
    "",
    `🛡️ Guardrail blocks/downgrades: ${guardrailCount}`,
    `🔎 Related detections: ${relatedDetections}`,
  ];

  return messageLines.join("\n").trim();
}

async function main(): Promise<void> {
  try {
    applyTradingCronReliabilityDefaults();
    const report = await runTradingPipeline({ runCommand: boundedRunCommand });
    console.log(buildCronAlertFromPipelineReport(report));
  } catch (error) {
    console.log(`📈 Trading Advisor - Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
