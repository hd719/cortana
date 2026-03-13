#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runTradingPipeline } from "./trading-pipeline";

const BACKTESTER_CWD = "/Users/hd/Developer/cortana-external/backtester";
const PYTHON_BIN = resolve(BACKTESTER_CWD, ".venv/bin/python");
const DEFAULT_SCAN_TIMEOUT_MS = 45_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
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

function boundedRunCommand(command: string, args: string[]): string {
  const resolvedCommand = command === "python3" ? PYTHON_BIN : command;
  const scriptName = args[0] ?? "";
  const timeoutMs = getScanTimeoutMs(scriptName);
  const strategyName =
    scriptName === "dipbuyer_alert.py" ? "Dip Buyer" : scriptName === "canslim_alert.py" ? "CANSLIM" : scriptName || command;

  const result = spawnSync(resolvedCommand, args, {
    cwd: BACKTESTER_CWD,
    encoding: "utf8",
    env: process.env,
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

function summarizeCounts(line: string | undefined, section: string): string {
  if (!line) return `${section}: unavailable`;
  const buy = Number(line.match(/BUY\s+(\d+)/i)?.[1] ?? 0);
  const watch = Number(line.match(/WATCH\s+(\d+)/i)?.[1] ?? 0);
  const noBuy = Number(line.match(/NO_BUY\s+(\d+)/i)?.[1] ?? 0);
  return `${section}: BUY ${buy} | WATCH ${watch} | NO_BUY ${noBuy}`;
}

function firstFocusSignal(lines: string[], section: string): string | null {
  const startIndex = lines.findIndex((line) => line.startsWith(`${section}:`));
  if (startIndex === -1) return null;

  let fallback: string | null = null;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;
    if (!line.startsWith("• ")) continue;
    if (fallback == null) fallback = line;
    if (!line.includes("→ NO_BUY")) return line;
  }

  return fallback;
}

function formatFocusLabel(line: string | null): string | null {
  if (!line) return null;
  const match = line.match(/^•\s+([A-Z.\-]+).*→\s+(BUY|WATCH|NO_BUY)/);
  if (!match) return line.replace(/^•\s+/, "").trim();
  return `${match[1]} ${match[2]}`;
}

export function buildCronAlertFromPipelineReport(report: string): string {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const decision = trimLabel(findLine(lines, "Decision:") ?? "Decision: unavailable", "Decision:");
  const confidence = trimLabel(findLine(lines, "Confidence:") ?? "Confidence: unavailable", "Confidence:");
  const regime = trimLabel(findLine(lines, "Regime/Gates:") ?? "Regime/Gates: unavailable", "Regime/Gates:");
  const summary = findLine(lines, "Summary:") ?? "Summary: unavailable";
  const noTrade = findLine(lines, "No-trade reason:");
  const blockerTelemetry = findLine(lines, "Blocker telemetry:");
  const canslimFocus = formatFocusLabel(firstFocusSignal(lines, "CANSLIM"));
  const dipFocus = formatFocusLabel(firstFocusSignal(lines, "Dip Buyer"));
  const councilLine = findLine(lines, "🏛️ Council (BUY signals only):");

  const compactLines = [
    "📈 Trading Advisor - Market Session Snapshot",
    `Decision: ${decision} | ${confidence}`,
    `Regime: ${regime}`,
    summary,
    summarizeCounts(findLine(lines, "CANSLIM:"), "CANSLIM"),
    summarizeCounts(findLine(lines, "Dip Buyer:"), "Dip Buyer"),
  ];

  const focusBits = [canslimFocus ? `CANSLIM ${canslimFocus}` : "", dipFocus ? `Dip ${dipFocus}` : ""].filter(Boolean);
  if (focusBits.length) compactLines.push(`Focus: ${focusBits.join(" | ")}`);
  if (noTrade) compactLines.push(`Reason: ${trimLabel(noTrade, "No-trade reason:")}`);
  else if (blockerTelemetry) compactLines.push(trimLabel(blockerTelemetry, "Blocker telemetry:"));
  if (councilLine) compactLines.push("Council ran for active BUY signals.");

  return compactLines.join("\n").trim();
}

async function main(): Promise<void> {
  try {
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
