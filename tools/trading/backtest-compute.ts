#!/usr/bin/env npx tsx

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  BACKTESTER_CWD,
  applyTradingCronReliabilityDefaults,
  boundedRunCommand,
  buildCronAlertFromPipelineReport,
  resolvePythonBin,
} from "./trading-cron-alert";
import { runTradingPipeline, runTradingStrategy, type TradingStrategyName } from "./trading-pipeline";

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
  };
  error?: {
    message: string;
    exitCode: number | null;
    signal: string | null;
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

function buildFailureMessage(strategy: string, message: string): string {
  return [
    `⚠️ Backtest - ${strategy}`,
    "Run failed.",
    message.slice(0, 500),
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
  const message = success
    ? (stdout.trim() || `Backtest completed successfully: ${config.strategy}`)
    : buildFailureMessage(config.strategy, (stderr || stdout || "backtest failed").trim());

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
  };
}

async function runPreset(config: Extract<CommandConfig, { mode: "preset" }>): Promise<CommandResult> {
  try {
    if (config.preset === "trading-unified") {
      const report = await runTradingPipeline({ runCommand: boundedRunCommand, includeCouncil: false });
      return {
        strategy: config.strategy,
        command: config.command,
        resolvedCommands: config.resolvedCommands,
        cwd: config.cwd,
        stdout: report,
        stderr: "",
        message: buildCronAlertFromPipelineReport(report),
        exitCode: 0,
        signal: null,
        metrics: extractUnifiedMetrics(report),
        notes: config.notes,
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
    return {
      strategy: config.strategy,
      command: config.command,
      resolvedCommands: config.resolvedCommands,
      cwd: config.cwd,
      stdout: "",
      stderr: message,
      message: buildFailureMessage(config.strategy, message),
      exitCode: 1,
      signal: null,
      metrics: {},
      notes: config.notes,
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
  const summaryTmpPath = path.join(outDir, "summary.tmp.json");
  const summaryPath = path.join(outDir, "summary.json");

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
    ].join("\n"),
  );

  const success = result.exitCode === 0 && !result.signal;
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
    },
    error: success
      ? undefined
      : {
          message: (result.stderr || result.stdout || result.message || "backtest failed").trim().slice(0, 1000),
          exitCode: result.exitCode,
          signal: result.signal,
        },
  };

  writeFileSync(summaryTmpPath, JSON.stringify(summary, null, 2) + "\n");
  renameSync(summaryTmpPath, summaryPath);

  process.stdout.write(`${summaryPath}\n`);
  process.exit(success ? 0 : result.exitCode ?? 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
