#!/usr/bin/env npx tsx

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  BACKTESTER_CWD,
  applyTradingCronReliabilityDefaults,
  boundedRunCommand,
  buildCronAlertFromPipelineSnapshot,
  extractSignalsFromPipelineReport,
  type ParsedSignal,
  resolvePythonBin,
} from "./trading-cron-alert";
import {
  runTradingPipelineDetailed,
  runTradingStrategy,
  type PipelineSnapshot,
  type TradingStrategyName,
} from "./trading-pipeline";
import { syncTradingRunFromArtifacts, syncTradingRunStarted } from "./trading-run-state";

type BacktestStatus = "success" | "failed";
type BacktestMetricValue = string | number | boolean | null;
type PresetName = "trading-unified" | "canslim-full-universe" | "dipbuyer-full-universe";

type BacktestSummary = {
  schemaVersion: 1;
  schema_version?: 1;
  runId: string;
  run_id?: string;
  strategy: string;
  status: BacktestStatus;
  createdAt: string;
  startedAt: string;
  finalizedAt: string;
  completedAt: string;
  notifiedAt: string | null;
  host: string;
  command: string[];
  resolvedCommands?: string[][];
  cwd: string;
  metrics: Record<string, BacktestMetricValue>;
  notes: string[];
  artifacts: {
    directory: string;
    summary: string;
    log: string;
    stdout?: string;
    stderr?: string;
    metrics?: string;
    message?: string;
    watchlistFullJson?: string;
    watchlistFullTxt?: string;
  };
  error?: {
    message: string;
    summary: string;
    exitCode: number | null;
    signal: string | null;
    stage: "market-regime" | "scanner" | "pipeline" | "command" | "unknown";
    kind: "transient" | "timeout" | "command-error" | "unknown";
    transient: boolean;
  };
};

type FullWatchlistEntry = {
  ticker: string;
  score: number;
  action: "BUY" | "WATCH" | "NO_BUY";
  strategy: "CANSLIM" | "Dip Buyer";
};
type StrategyOutcomeClass = PipelineSnapshot["strategies"]["canslim"]["outcomeClass"];
type FullWatchlistStrategyArtifact = {
  outcomeClass?: StrategyOutcomeClass;
  buy: FullWatchlistEntry[];
  watch: FullWatchlistEntry[];
  noBuy: FullWatchlistEntry[];
};

export type FullWatchlistArtifact = {
  schemaVersion: 1;
  schema_version?: 1;
  runId: string;
  run_id?: string;
  generatedAt: string;
  decision: string;
  correctionMode: boolean;
  summary: {
    buy: number;
    watch: number;
    noBuy: number;
  };
  focus: {
    ticker: string;
    action: "BUY" | "WATCH" | "NO_BUY";
    strategy: "CANSLIM" | "Dip Buyer";
  } | null;
  strategies: {
    canslim: FullWatchlistStrategyArtifact;
    dipBuyer: FullWatchlistStrategyArtifact;
  };
};

const DEFAULT_ROOT = path.join(process.cwd(), "var", "backtests");
const RUNS_DIR = path.join(process.env.BACKTEST_ROOT_DIR || DEFAULT_ROOT, "runs");
const DEFAULT_PRESET: PresetName = "trading-unified";
const PRESET_STRATEGY_LABELS: Record<PresetName, string> = {
  "trading-unified": "Trading market-session unified",
  "canslim-full-universe": "CANSLIM full-universe",
  "dipbuyer-full-universe": "Dip Buyer full-universe",
};

type CommandConfig =
  | { mode: "shell"; raw: string; command: string[]; cwd: string; strategy: string }
  | { mode: "preset"; preset: PresetName; command: string[]; resolvedCommands: string[][]; cwd: string; strategy: string; notes: string[] };

type CommandResult = {
  strategy: string;
  command: string[];
  resolvedCommands?: string[][];
  cwd: string;
  stdout: string;
  stderr: string;
  message: string;
  exitCode: number | null;
  signal: string | null;
  metrics: Record<string, BacktestMetricValue>;
  notes: string[];
  pipelineSnapshot?: PipelineSnapshot;
  failure?: {
    summary: string;
    stage: "market-regime" | "scanner" | "pipeline" | "command" | "unknown";
    kind: "transient" | "timeout" | "command-error" | "unknown";
    transient: boolean;
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function parseMetrics(raw: string): Record<string, BacktestMetricValue> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, BacktestMetricValue>;
    }
  } catch {
    // ignore
  }
  return {};
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function normalizePreset(raw: string | undefined): PresetName {
  const value = (raw || DEFAULT_PRESET).trim().toLowerCase();
  if (value === "canslim" || value === "canslim-full-universe") return "canslim-full-universe";
  if (value === "dipbuyer" || value === "dip-buyer" || value === "dipbuyer-full-universe") return "dipbuyer-full-universe";
  return "trading-unified";
}

function getStrategyLabel(preset: PresetName): string {
  return process.env.BACKTEST_STRATEGY?.trim() || PRESET_STRATEGY_LABELS[preset];
}

function getScanLimit(strategy: TradingStrategyName): number {
  const raw =
    strategy === "CANSLIM"
      ? process.env.TRADING_SCAN_LIMIT_CANSLIM ?? process.env.TRADING_SCAN_LIMIT
      : process.env.TRADING_SCAN_LIMIT_DIP ?? process.env.TRADING_SCAN_LIMIT;
  return parsePositiveInt(raw, 120);
}

function getChunkSize(strategy: TradingStrategyName): number {
  const raw =
    strategy === "CANSLIM"
      ? process.env.TRADING_SCAN_CHUNK_SIZE_CANSLIM ?? process.env.TRADING_SCAN_CHUNK_SIZE
      : process.env.TRADING_SCAN_CHUNK_SIZE_DIP ?? process.env.TRADING_SCAN_CHUNK_SIZE;
  const chunkSize = parsePositiveInt(raw, 0);
  return chunkSize > 0 ? Math.min(chunkSize, getScanLimit(strategy)) : 0;
}

function describeStrategyCommand(strategy: TradingStrategyName): string[] {
  const script = strategy === "CANSLIM" ? "canslim_alert.py" : "dipbuyer_alert.py";
  const scanLimit = getScanLimit(strategy);
  const chunkSize = getChunkSize(strategy);
  const universeArg = chunkSize > 0 && chunkSize < scanLimit ? chunkSize : scanLimit;
  return [resolvePythonBin(), script, "--limit", "8", "--min-score", "6", "--universe-size", String(universeArg)];
}

function parseCommandConfig(): CommandConfig {
  const raw = process.env.BACKTEST_COMPUTE_COMMAND?.trim();
  if (raw) {
    return {
      mode: "shell",
      raw,
      command: ["/bin/sh", "-lc", raw],
      cwd: process.env.BACKTEST_CWD || process.cwd(),
      strategy: process.env.BACKTEST_STRATEGY || "unnamed-strategy",
    };
  }

  applyTradingCronReliabilityDefaults();
  const preset = normalizePreset(process.env.BACKTEST_PRESET);
  const cwd = process.env.BACKTEST_CWD || BACKTESTER_CWD;

  if (preset === "trading-unified") {
    return {
      mode: "preset",
      preset,
      command: ["node", "--import", "tsx", "./tools/trading/trading-cron-alert.ts"],
      resolvedCommands: [
        describeStrategyCommand("CANSLIM"),
        describeStrategyCommand("Dip Buyer"),
      ],
      cwd,
      strategy: getStrategyLabel(preset),
      notes: [
        "Preset uses the existing trading pipeline with chunked full-universe scans.",
        "Chunked scanner invocations set TRADING_PRIORITY_FILE per chunk for deterministic coverage.",
        "stdout.txt stores the full unified pipeline report; message.txt stores the compact Telegram payload.",
      ],
    };
  }

  const strategy = preset === "canslim-full-universe" ? "CANSLIM" : "Dip Buyer";
  return {
    mode: "preset",
    preset,
    command: describeStrategyCommand(strategy),
    resolvedCommands: [describeStrategyCommand(strategy)],
    cwd,
    strategy: getStrategyLabel(preset),
    notes: [
      `${strategy} preset runs through the chunked full-universe trading pipeline.`,
      "Chunked scanner invocations set TRADING_PRIORITY_FILE per chunk for deterministic coverage.",
      "message.txt mirrors the persisted strategy report for notifier delivery.",
    ],
  };
}

function numberFrom(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function textFrom(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1]?.trim() ?? null;
}

function extractUnifiedMetrics(report: string): Record<string, BacktestMetricValue> {
  const metrics: Record<string, BacktestMetricValue> = {};
  const summaryLine = report.split(/\r?\n/).find((line) => line.startsWith("Summary:")) || "";
  const diagnosticsLine = report.split(/\r?\n/).find((line) => line.startsWith("Diagnostics:")) || "";
  const decision = textFrom(report, /^Decision:\s*(.+)$/m);
  const confidence = numberFrom(report, /^Confidence:\s*([0-9.]+)\s*\|/m);
  const risk = textFrom(report, /^Confidence:\s*[0-9.]+\s*\|\s*Risk:\s*(.+)$/m);
  const correctionMode = textFrom(report, /^Regime\/Gates:\s*correction=(YES|NO)/m);

  if (decision) metrics.decision = decision;
  if (confidence != null) metrics.confidence = confidence;
  if (risk) metrics.risk = risk;
  if (correctionMode) metrics.correctionMode = correctionMode === "YES";

  const summaryPairs: Array<[string, RegExp]> = [
    ["buy", /BUY\s+(\d+)/i],
    ["watch", /WATCH\s+(\d+)/i],
    ["noBuy", /NO_BUY\s+(\d+)/i],
  ];
  for (const [key, pattern] of summaryPairs) {
    const value = numberFrom(summaryLine, pattern);
    if (value != null) metrics[key] = value;
  }

  const scanned = numberFrom(diagnosticsLine, /symbols scanned\s+(\d+)/i);
  const evaluated = numberFrom(diagnosticsLine, /candidates evaluated\s+(\d+)/i);
  if (scanned != null) metrics.symbolsScanned = scanned;
  if (evaluated != null) metrics.candidatesEvaluated = evaluated;

  for (const section of ["CANSLIM", "Dip Buyer"] as const) {
    const line = report.split(/\r?\n/).find((entry) => entry.startsWith(`${section}:`)) || "";
    const prefix = section === "CANSLIM" ? "canslim" : "dipBuyer";
    const pairs: Array<[string, RegExp]> = [
      ["scanned", /scanned\s+(\d+)/i],
      ["evaluated", /evaluated\s+(\d+)/i],
      ["thresholdPassed", /threshold-passed\s+(\d+)/i],
      ["buy", /BUY\s+(\d+)/i],
      ["watch", /WATCH\s+(\d+)/i],
      ["noBuy", /NO_BUY\s+(\d+)/i],
    ];
    for (const [key, pattern] of pairs) {
      const value = numberFrom(line, pattern);
      if (value != null) metrics[`${prefix}${key[0].toUpperCase()}${key.slice(1)}`] = value;
    }
  }

  return metrics;
}

export function extractUnifiedMetricsFromSnapshot(snapshot: PipelineSnapshot): Record<string, BacktestMetricValue> {
  return {
    decision: snapshot.decision,
    confidence: snapshot.confidence,
    risk: snapshot.risk,
    correctionMode: snapshot.correctionMode,
    buy: snapshot.summary.buy,
    watch: snapshot.summary.watch,
    noBuy: snapshot.summary.noBuy,
    symbolsScanned: snapshot.strategies.canslim.scanned + snapshot.strategies.dipBuyer.scanned,
    candidatesEvaluated: snapshot.relatedDetections,
    canslimScanned: snapshot.strategies.canslim.scanned,
    canslimEvaluated: snapshot.strategies.canslim.evaluated,
    canslimThresholdPassed: snapshot.strategies.canslim.thresholdPassed,
    canslimBuy: snapshot.strategies.canslim.buy,
    canslimWatch: snapshot.strategies.canslim.watch,
    canslimNoBuy: snapshot.strategies.canslim.noBuy,
    dipBuyerScanned: snapshot.strategies.dipBuyer.scanned,
    dipBuyerEvaluated: snapshot.strategies.dipBuyer.evaluated,
    dipBuyerThresholdPassed: snapshot.strategies.dipBuyer.thresholdPassed,
    dipBuyerBuy: snapshot.strategies.dipBuyer.buy,
    dipBuyerWatch: snapshot.strategies.dipBuyer.watch,
    dipBuyerNoBuy: snapshot.strategies.dipBuyer.noBuy,
  };
}

function extractStrategyMetrics(report: string): Record<string, BacktestMetricValue> {
  const metrics: Record<string, BacktestMetricValue> = {};
  const summaryLine = report.split(/\r?\n/).find((line) => line.startsWith("Summary:")) || "";
  const marketLine = report.split(/\r?\n/).find((line) => line.startsWith("Market:"));
  const statusLine = report.split(/\r?\n/).find((line) => line.startsWith("Status:"));
  const pairs: Array<[string, RegExp]> = [
    ["scanned", /scanned\s+(\d+)/i],
    ["evaluated", /evaluated\s+(\d+)/i],
    ["thresholdPassed", /threshold-passed\s+(\d+)/i],
    ["buy", /BUY\s+(\d+)/i],
    ["watch", /WATCH\s+(\d+)/i],
    ["noBuy", /NO_BUY\s+(\d+)/i],
  ];

  for (const [key, pattern] of pairs) {
    const value = numberFrom(summaryLine, pattern);
    if (value != null) metrics[key] = value;
  }
  if (marketLine) metrics.market = marketLine.replace(/^Market:\s*/i, "").trim();
  if (statusLine) metrics.status = statusLine.replace(/^Status:\s*/i, "").trim();
  return metrics;
}

function textFromLine(report: string, prefix: string): string | null {
  const line = report.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  if (!line) return null;
  return line.slice(prefix.length).trim();
}

function countFromSummaryLine(line: string | null, token: "BUY" | "WATCH" | "NO_BUY"): number {
  if (!line) return 0;
  const match = line.match(new RegExp(`${token}\\s+(\\d+)`, "i"));
  const value = Number(match?.[1] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function strategyFromSection(section: string): "CANSLIM" | "Dip Buyer" {
  return section === "CANSLIM" ? "CANSLIM" : "Dip Buyer";
}

function toEntry(signal: ParsedSignal): FullWatchlistEntry {
  return {
    ticker: signal.ticker,
    score: signal.score,
    action: signal.action,
    strategy: strategyFromSection(signal.section),
  };
}

export function buildFullWatchlistArtifact(
  runIdValue: string,
  report: string,
  generatedAtValue = nowIso(),
): FullWatchlistArtifact | null {
  if (!/(^|\n)Summary:/m.test(report)) return null;
  if (!/(^|\n)CANSLIM:/m.test(report) && !/(^|\n)Dip Buyer:/m.test(report)) return null;

  const decision = textFromLine(report, "Decision:") || "unavailable";
  const regime = textFromLine(report, "Regime/Gates:") || "";
  const correctionMode = /correction=YES/i.test(regime) || /\bcorrection\b/i.test(regime);
  const summaryLine = textFromLine(report, "Summary:");
  const signals = extractSignalsFromPipelineReport(report);
  const allSignals = [...signals.canslim, ...signals.dipBuyer];
  const buySignals = allSignals.filter((signal) => signal.action === "BUY");
  const focusSignal =
    buySignals[0] ??
    [...signals.dipBuyer, ...signals.canslim].find((signal) => signal.action !== "NO_BUY") ??
    null;

  const byAction = (items: ParsedSignal[], action: "BUY" | "WATCH" | "NO_BUY"): FullWatchlistEntry[] =>
    items.filter((signal) => signal.action === action).map(toEntry);

  return {
    schemaVersion: 1,
    schema_version: 1,
    runId: runIdValue,
    run_id: runIdValue,
    generatedAt: generatedAtValue,
    decision,
    correctionMode,
    summary: {
      buy: countFromSummaryLine(summaryLine, "BUY"),
      watch: countFromSummaryLine(summaryLine, "WATCH"),
      noBuy: countFromSummaryLine(summaryLine, "NO_BUY"),
    },
    focus: focusSignal ? toEntry(focusSignal) : null,
    strategies: {
      canslim: {
        outcomeClass: undefined,
        buy: byAction(signals.canslim, "BUY"),
        watch: byAction(signals.canslim, "WATCH"),
        noBuy: byAction(signals.canslim, "NO_BUY"),
      },
      dipBuyer: {
        outcomeClass: undefined,
        buy: byAction(signals.dipBuyer, "BUY"),
        watch: byAction(signals.dipBuyer, "WATCH"),
        noBuy: byAction(signals.dipBuyer, "NO_BUY"),
      },
    },
  };
}

function snapshotSignalToEntry(
  signal: PipelineSnapshot["strategies"]["canslim"]["signals"][number],
): FullWatchlistEntry {
  return {
    ticker: signal.ticker,
    score: signal.score ?? 0,
    action: signal.action,
    strategy: signal.section,
  };
}

export function buildFullWatchlistArtifactFromSnapshot(
  runIdValue: string,
  snapshot: PipelineSnapshot,
  generatedAtValue = nowIso(),
): FullWatchlistArtifact {
  const allSignals = [...snapshot.strategies.canslim.signals, ...snapshot.strategies.dipBuyer.signals];
  const buySignals = allSignals.filter((signal) => signal.action === "BUY");
  const focusSignal =
    buySignals[0] ??
    [...snapshot.strategies.dipBuyer.signals, ...snapshot.strategies.canslim.signals].find((signal) => signal.action !== "NO_BUY") ??
    null;
  const byAction = (
    items: PipelineSnapshot["strategies"]["canslim"]["signals"],
    action: "BUY" | "WATCH" | "NO_BUY",
  ): FullWatchlistEntry[] => items.filter((signal) => signal.action === action).map(snapshotSignalToEntry);

  return {
    schemaVersion: 1,
    schema_version: 1,
    runId: runIdValue,
    run_id: runIdValue,
    generatedAt: generatedAtValue,
    decision: snapshot.decision,
    correctionMode: snapshot.correctionMode,
    summary: {
      buy: snapshot.summary.buy,
      watch: snapshot.summary.watch,
      noBuy: snapshot.summary.noBuy,
    },
    focus: focusSignal ? snapshotSignalToEntry(focusSignal) : null,
    strategies: {
      canslim: {
        outcomeClass: snapshot.strategies.canslim.outcomeClass,
        buy: byAction(snapshot.strategies.canslim.signals, "BUY"),
        watch: byAction(snapshot.strategies.canslim.signals, "WATCH"),
        noBuy: byAction(snapshot.strategies.canslim.signals, "NO_BUY"),
      },
      dipBuyer: {
        outcomeClass: snapshot.strategies.dipBuyer.outcomeClass,
        buy: byAction(snapshot.strategies.dipBuyer.signals, "BUY"),
        watch: byAction(snapshot.strategies.dipBuyer.signals, "WATCH"),
        noBuy: byAction(snapshot.strategies.dipBuyer.signals, "NO_BUY"),
      },
    },
  };
}

function formatEntries(entries: FullWatchlistEntry[]): string {
  if (!entries.length) return "none";
  return entries.map((entry) => `${entry.ticker} ${entry.score}/12`).join(" · ");
}

function formatStrategyOutcomeLine(outcomeClass: StrategyOutcomeClass): string | undefined {
  if (!outcomeClass || outcomeClass === "healthy_candidates_found") return undefined;

  if (outcomeClass === "analysis_failed") return "analysis failed";
  if (outcomeClass === "market_gate_blocked") return "market gate blocked";
  if (outcomeClass === "healthy_no_candidates") return "healthy no candidates";
  return outcomeClass.replace(/_/g, " ");
}

function writeAtomically(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, targetPath);
}

export function formatFullWatchlistArtifactText(artifact: FullWatchlistArtifact): string {
  const canslimOutcome = formatStrategyOutcomeLine(artifact.strategies.canslim.outcomeClass);
  const dipOutcome = formatStrategyOutcomeLine(artifact.strategies.dipBuyer.outcomeClass);

  return [
    "Trading Watchlist - Full",
    `Run: ${artifact.runId}`,
    `Generated: ${artifact.generatedAt}`,
    `Decision: ${artifact.decision}`,
    `Regime: correction=${artifact.correctionMode ? "YES" : "NO"}`,
    `Summary: BUY ${artifact.summary.buy} | WATCH ${artifact.summary.watch} | NO_BUY ${artifact.summary.noBuy}`,
    artifact.focus
      ? `Focus: ${artifact.focus.ticker} ${artifact.focus.score}/12 → ${artifact.focus.action} (${artifact.focus.strategy})`
      : "Focus: unavailable",
    canslimOutcome
      ? `CANSLIM status: ${canslimOutcome}`
      : "CANSLIM status: unavailable",
    dipOutcome
      ? `Dip Buyer status: ${dipOutcome}`
      : "Dip Buyer status: unavailable",
    "",
    `Dip Buyer BUY (${artifact.strategies.dipBuyer.buy.length}): ${formatEntries(artifact.strategies.dipBuyer.buy)}`,
    `Dip Buyer WATCH (${artifact.strategies.dipBuyer.watch.length}): ${formatEntries(artifact.strategies.dipBuyer.watch)}`,
    `Dip Buyer NO_BUY (${artifact.strategies.dipBuyer.noBuy.length}): ${formatEntries(artifact.strategies.dipBuyer.noBuy)}`,
    "",
    `CANSLIM BUY (${artifact.strategies.canslim.buy.length}): ${formatEntries(artifact.strategies.canslim.buy)}`,
    `CANSLIM WATCH (${artifact.strategies.canslim.watch.length}): ${formatEntries(artifact.strategies.canslim.watch)}`,
    `CANSLIM NO_BUY (${artifact.strategies.canslim.noBuy.length}): ${formatEntries(artifact.strategies.canslim.noBuy)}`,
  ].join("\n");
}

function compactFailure(raw: string): {
  summary: string;
  stage: "market-regime" | "scanner" | "pipeline" | "command" | "unknown";
  kind: "transient" | "timeout" | "command-error" | "unknown";
  transient: boolean;
} {
  const normalized = raw.replace(/\s+/g, " ").trim() || "backtest failed";
  const lower = normalized.toLowerCase();
  const firstSentence = normalized.split(/(?<=[.!?])\s+/)[0] || normalized;
  const transient = /cooldown|rate limit|429|503|504|transient|temporar|unavailable/.test(lower);

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      summary: "Scanner timed out before producing a completed summary.",
      stage: "scanner",
      kind: "timeout",
      transient: false,
    };
  }

  if (
    lower.includes("market regime")
    || (lower.includes("spy") && lower.includes("90d"))
    || lower.includes("distribution day")
  ) {
    return {
      summary: transient
        ? "Market regime refresh failed: transient SPY 90d provider cooldown blocked the scan."
        : "Market regime refresh failed before the scanner could complete.",
      stage: "market-regime",
      kind: transient ? "transient" : "command-error",
      transient,
    };
  }

  if (lower.includes("canslim") || lower.includes("dip buyer") || lower.includes("dipbuyer") || lower.includes("chunk ")) {
    return {
      summary: firstSentence.slice(0, 220),
      stage: "scanner",
      kind: transient ? "transient" : "command-error",
      transient,
    };
  }

  return {
    summary: firstSentence.slice(0, 220),
    stage: lower.includes("python") || lower.includes("command") ? "command" : "pipeline",
    kind: transient ? "transient" : "command-error",
    transient,
  };
}

function buildFailureMessage(strategy: string, failureSummary: string): string {
  return [
    `⚠️ Backtest - ${strategy}`,
    "Run failed.",
    failureSummary.slice(0, 500),
  ].join("\n");
}

function runShellCommand(config: Extract<CommandConfig, { mode: "shell" }>): CommandResult {
  const child = spawnSync(config.command[0], config.command.slice(1), {
    cwd: config.cwd,
    encoding: "utf8",
    env: process.env,
    timeout: process.env.BACKTEST_TIMEOUT_MS ? Number(process.env.BACKTEST_TIMEOUT_MS) : undefined,
  });

  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  const success = child.status === 0 && !child.signal;
  const failure = success ? undefined : compactFailure((stderr || stdout || "backtest failed").trim());
  const message = success
    ? (stdout.trim() || `Backtest completed successfully: ${config.strategy}`)
    : buildFailureMessage(config.strategy, failure?.summary || "backtest failed");

  return {
    strategy: config.strategy,
    command: config.command,
    cwd: config.cwd,
    stdout,
    stderr,
    message,
    exitCode: child.status ?? null,
    signal: child.signal ?? null,
    metrics: {},
    notes: [],
    failure,
  };
}

async function runPreset(config: Extract<CommandConfig, { mode: "preset" }>): Promise<CommandResult> {
  try {
    if (config.preset === "trading-unified") {
      const { report, snapshot } = await runTradingPipelineDetailed({ runCommand: boundedRunCommand, includeCouncil: false });
      return {
        strategy: config.strategy,
        command: config.command,
        resolvedCommands: config.resolvedCommands,
        cwd: config.cwd,
        stdout: report,
        stderr: "",
        message: buildCronAlertFromPipelineSnapshot(snapshot),
        exitCode: 0,
        signal: null,
        metrics: extractUnifiedMetricsFromSnapshot(snapshot),
        notes: config.notes,
        pipelineSnapshot: snapshot,
      };
    }

    const strategy: TradingStrategyName = config.preset === "canslim-full-universe" ? "CANSLIM" : "Dip Buyer";
    const report = await runTradingStrategy(strategy, { runCommand: boundedRunCommand, includeCouncil: false });
    return {
      strategy: config.strategy,
      command: config.command,
      resolvedCommands: config.resolvedCommands,
      cwd: config.cwd,
      stdout: report,
      stderr: "",
      message: report,
      exitCode: 0,
      signal: null,
      metrics: extractStrategyMetrics(report),
      notes: config.notes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = compactFailure(message);
    return {
      strategy: config.strategy,
      command: config.command,
      resolvedCommands: config.resolvedCommands,
      cwd: config.cwd,
      stdout: "",
      stderr: message,
      message: buildFailureMessage(config.strategy, failure.summary),
      exitCode: 1,
      signal: null,
      metrics: {},
      notes: config.notes,
      failure,
    };
  }
}

async function main(): Promise<void> {
  const id = process.env.BACKTEST_RUN_ID || runId();
  const startedAt = nowIso();
  const config = parseCommandConfig();

  const outDir = path.join(RUNS_DIR, id);
  mkdirSync(outDir, { recursive: true });

  const logPath = path.join(outDir, "run.log");
  const stdoutPath = path.join(outDir, "stdout.txt");
  const stderrPath = path.join(outDir, "stderr.txt");
  const metricsPath = path.join(outDir, "metrics.json");
  const messagePath = path.join(outDir, "message.txt");
  const watchlistFullJsonPath = path.join(outDir, "watchlist-full.json");
  const watchlistFullTxtPath = path.join(outDir, "watchlist-full.txt");
  const summaryTmpPath = path.join(outDir, "summary.tmp.json");
  const summaryPath = path.join(outDir, "summary.json");

  const startedSync = syncTradingRunStarted({
    runId: id,
    strategy: config.strategy,
    createdAt: startedAt,
    startedAt,
    artifactDirectory: outDir,
    summaryPath,
    messagePath,
    watchlistPath: watchlistFullJsonPath,
  });
  if (!startedSync.ok) {
    process.stderr.write(
      `MISSION_CONTROL_TRADING_RUN_SYNC_${startedSync.mode.toUpperCase()} run_id=${id} stage=start reason=${startedSync.reason}\n`,
    );
  }

  const result = config.mode === "shell" ? runShellCommand(config) : await runPreset(config);

  writeFileSync(stdoutPath, result.stdout);
  writeFileSync(stderrPath, result.stderr);
  writeFileSync(messagePath, `${result.message.trim()}\n`);

  const metrics = {
    ...result.metrics,
    ...parseMetrics(process.env.BACKTEST_METRICS_JSON || "{}"),
  };
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2) + "\n");

  const completedAt = nowIso();
  const success = result.exitCode === 0 && !result.signal;
  let watchlistArtifactWritten = false;
  let watchlistArtifactError: string | null = null;
  if (success) {
    try {
      const watchlistArtifact = result.pipelineSnapshot
        ? buildFullWatchlistArtifactFromSnapshot(id, result.pipelineSnapshot, completedAt)
        : buildFullWatchlistArtifact(id, result.stdout, completedAt);
      if (watchlistArtifact) {
        writeAtomically(watchlistFullJsonPath, JSON.stringify(watchlistArtifact, null, 2) + "\n");
        writeAtomically(watchlistFullTxtPath, formatFullWatchlistArtifactText(watchlistArtifact) + "\n");
        watchlistArtifactWritten = true;
      }
    } catch (error) {
      watchlistArtifactError = error instanceof Error ? error.message : String(error);
    }
  }

  writeFileSync(
    logPath,
    [
      `# strategy: ${result.strategy}`,
      `# run_id: ${id}`,
      `# started_at: ${startedAt}`,
      `# completed_at: ${completedAt}`,
      `# cwd: ${result.cwd}`,
      `# command: ${result.command.join(" ")}`,
      ...(result.resolvedCommands?.length
        ? [
            "# resolved_commands:",
            ...result.resolvedCommands.map((command) => `#   - ${command.join(" ")}`),
          ]
        : []),
      `# exit_code: ${result.exitCode ?? "null"}`,
      `# signal: ${result.signal ?? "null"}`,
      "",
      "[stdout]",
      result.stdout,
      "",
      "[stderr]",
      result.stderr,
      "",
      "[message]",
      result.message,
      "",
      "[watchlist_artifact]",
      watchlistArtifactWritten
        ? `wrote ${watchlistFullJsonPath} and ${watchlistFullTxtPath}`
        : watchlistArtifactError
          ? `failed: ${watchlistArtifactError}`
          : "skipped",
    ].join("\n"),
  );

  const summary: BacktestSummary = {
    schemaVersion: 1,
    schema_version: 1,
    runId: id,
    run_id: id,
    strategy: result.strategy,
    status: success ? "success" : "failed",
    createdAt: startedAt,
    startedAt,
    finalizedAt: completedAt,
    completedAt,
    notifiedAt: null,
    host: os.hostname(),
    command: result.command,
    resolvedCommands: result.resolvedCommands,
    cwd: result.cwd,
    metrics,
    notes: [
      "summary.json is written atomically via summary.tmp.json + rename",
      "notifier should only send completed runs with notifiedAt == null",
      "message.txt is the durable notification payload when present",
      watchlistArtifactWritten
        ? "watchlist-full.json and watchlist-full.txt capture the full post-guard BUY/WATCH/NO_BUY sets for this run"
        : watchlistArtifactError
          ? `watchlist artifact write failed (non-blocking): ${watchlistArtifactError}`
          : "watchlist artifact generation skipped because the run did not emit a parseable unified watchlist report",
      ...result.notes,
    ],
    artifacts: {
      directory: outDir,
      summary: summaryPath,
      log: logPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      metrics: metricsPath,
      message: messagePath,
      ...(watchlistArtifactWritten
        ? {
            watchlistFullJson: watchlistFullJsonPath,
            watchlistFullTxt: watchlistFullTxtPath,
          }
        : {}),
    },
    error: success
      ? undefined
      : {
          message: (result.stderr || result.stdout || result.message || "backtest failed").trim().slice(0, 1000),
          summary: result.failure?.summary || "backtest failed",
          exitCode: result.exitCode,
          signal: result.signal,
          stage: result.failure?.stage || "unknown",
          kind: result.failure?.kind || "unknown",
          transient: result.failure?.transient === true,
        },
  };

  writeFileSync(summaryTmpPath, JSON.stringify(summary, null, 2) + "\n");
  renameSync(summaryTmpPath, summaryPath);

  const finalSync = syncTradingRunFromArtifacts(summaryPath);
  if (!finalSync.ok) {
    process.stderr.write(
      `MISSION_CONTROL_TRADING_RUN_SYNC_${finalSync.mode.toUpperCase()} run_id=${id} stage=finalize reason=${finalSync.reason}\n`,
    );
  }

  process.stdout.write(`${summaryPath}\n`);
  if (!success && summary.error) {
    process.stderr.write(
      `FAILED_BACKTEST_SUMMARY run_id=${id} summary_path=${summaryPath} stage=${summary.error.stage} transient=${summary.error.transient ? "true" : "false"} summary=${summary.error.summary}\n`,
    );
  }
  process.exit(success ? 0 : result.exitCode ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
