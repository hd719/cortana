#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parseSignals, runTradingCouncil, type CouncilVerdict, type TradingSignal } from "../council/trading-council";

const DEFAULT_SCAN_LIMIT = 120;
const BACKTESTER_CWD = "/Users/hd/Developer/cortana-external/backtester";
const BACKTESTER_ENV_PATH = resolve(BACKTESTER_CWD, ".env");
const SHARED_EXTERNAL_ENV_PATH = "/Users/hd/Developer/cortana-external/.env";

interface ScanResult {
  name: "CANSLIM" | "Dip Buyer";
  output: string;
  signals: TradingSignal[];
  marketRegime?: string;
  marketLine?: string;
  statusLine?: string;
  macroGateLine?: string;
  hyNoteLine?: string;
  dipProfileLine?: string;
  candidatesEvaluated: number;
  scanned: number;
  thresholdPassed: number;
  scanLimit: number;
  blockerLine?: string;
  blockerSamplesLine?: string;
  blockedByGuards?: number;
  guardNotes?: string[];
  failClosed?: boolean;
  failClosedReason?: string;
}

type DecisionState = "BUY" | "WATCH" | "NO_TRADE";

interface PipelineDeps {
  runCommand: (command: string, args: string[]) => string;
  council: (alertText: string) => Promise<{ verdicts: CouncilVerdict[] }>;
}

interface CorrectionProfile {
  dipMaxBuys: number;
  dipMinBuyScore: number;
}

function loadBacktesterEnv(): void {
  for (const envPath of [BACKTESTER_ENV_PATH, SHARED_EXTERNAL_ENV_PATH]) {
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath, override: false });
    }
  }
}

function ensurePythonModuleAvailable(moduleName: string, options?: { optional?: boolean }): void {
  const pythonPath = resolve(BACKTESTER_CWD, ".venv/bin/python");
  const check = spawnSync(pythonPath, ["-c", `import ${moduleName}`], { encoding: "utf8" });
  if (check.status === 0) return;

  if (options?.optional) {
    console.warn(
      `Trading Advisor preflight warning: optional Python module '${moduleName}' is not available in ${pythonPath}. ` +
        "Continuing because the backtester has a built-in fallback.",
    );
    return;
  }

  throw new Error(
    [
      `Trading Advisor dependency check failed: Python module '${moduleName}' is not available in ${pythonPath}.`,
      `Install dependencies with: ${pythonPath} -m pip install -r ${resolve(BACKTESTER_CWD, "requirements.txt")}`,
    ].join("\n"),
  );
}

function ensureFredApiKey(): void {
  const rawFredKey = process.env.FRED_API_KEY ?? "";
  const fredKey = rawFredKey.trim();
  if (!fredKey) {
    throw new Error(
      [
        "Trading Advisor requires FRED_API_KEY for Dip Buyer scans.",
        `Set FRED_API_KEY in your shell or add it to one of: ${BACKTESTER_ENV_PATH} or ${SHARED_EXTERNAL_ENV_PATH}.`,
      ].join("\n"),
    );
  }

  if (/\s/.test(rawFredKey)) {
    throw new Error(
      "Trading Advisor FRED_API_KEY is invalid: it must not contain whitespace characters (spaces/newlines/tabs).",
    );
  }
}

function defaultRunCommand(command: string, args: string[]): string {
  const resolvedCommand = command === "python3" ? `${BACKTESTER_CWD}/.venv/bin/python` : command;

  const result = spawnSync(resolvedCommand, args, {
    cwd: BACKTESTER_CWD,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }

  return (result.stdout || "").trim();
}

function summarizeSignals(signals: TradingSignal[]) {
  return {
    buy: signals.filter((s) => s.action === "BUY"),
    watch: signals.filter((s) => s.action === "WATCH"),
    noBuy: signals.filter((s) => s.action === "NO_BUY"),
  };
}

function parseMarketLine(text: string): { marketRegime?: string; marketLine?: string; statusLine?: string } {
  const lines = text.split(/\r?\n/);
  const marketLine = lines.find((l) => l.startsWith("Market:"));
  const statusLine = lines.find((l) => l.startsWith("Status:"));
  if (!marketLine) return { statusLine };
  const marketRegime = marketLine.match(/^Market:\s*([^|]+)/i)?.[1]?.trim().toLowerCase();
  return { marketRegime, marketLine, statusLine };
}

function parseSummaryCounts(text: string): { candidatesEvaluated: number; scanned: number; thresholdPassed: number } {
  const summaryLine = text.split(/\r?\n/).find((l) => l.startsWith("Summary:"));
  const scanned = Number(summaryLine?.match(/scanned\s+(\d+)/i)?.[1] ?? 0);
  const candidatesEvaluated = Number(summaryLine?.match(/evaluated\s+(\d+)/i)?.[1] ?? summaryLine?.match(/Summary:\s*(\d+)\s+candidates/i)?.[1] ?? 0);
  const thresholdPassed = Number(summaryLine?.match(/threshold-passed\s+(\d+)/i)?.[1] ?? candidatesEvaluated);
  return { candidatesEvaluated, scanned, thresholdPassed };
}

function parseDipDiagnostics(text: string): { macroGateLine?: string; hyNoteLine?: string; dipProfileLine?: string; blockerLine?: string; blockerSamplesLine?: string } {
  const lines = text.split(/\r?\n/);
  return {
    macroGateLine: lines.find((l) => l.startsWith("Macro Gate:")),
    hyNoteLine: lines.find((l) => l.startsWith("HY Note:")),
    dipProfileLine: lines.find((l) => l.startsWith("Dip Profile:")),
    blockerLine: lines.find((l) => l.startsWith("Blockers:")),
    blockerSamplesLine: lines.find((l) => l.startsWith("Blocker samples:")),
  };
}

function parseCommonDiagnostics(text: string): { blockerLine?: string; blockerSamplesLine?: string } {
  const lines = text.split(/\r?\n/);
  return {
    blockerLine: lines.find((l) => l.startsWith("Blockers:")),
    blockerSamplesLine: lines.find((l) => l.startsWith("Blocker samples:")),
  };
}

function getScanLimit(strategy: "CANSLIM" | "Dip Buyer"): number {
  const raw =
    strategy === "CANSLIM"
      ? process.env.TRADING_SCAN_LIMIT_CANSLIM ?? process.env.TRADING_SCAN_LIMIT
      : process.env.TRADING_SCAN_LIMIT_DIP ?? process.env.TRADING_SCAN_LIMIT;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCAN_LIMIT;
  }

  return Math.round(parsed);
}

function getCorrectionProfile(): CorrectionProfile {
  const maxBuysRaw = Number(process.env.TRADING_DIP_CORRECTION_MAX_BUYS ?? "1");
  const minScoreRaw = Number(process.env.TRADING_DIP_CORRECTION_MIN_BUY_SCORE ?? "8");
  const dipMaxBuys = Number.isFinite(maxBuysRaw) ? Math.max(0, Math.round(maxBuysRaw)) : 1;
  const dipMinBuyScore = Number.isFinite(minScoreRaw) ? Math.max(0, Math.round(minScoreRaw)) : 8;
  return { dipMaxBuys, dipMinBuyScore };
}

function formatSignalLine(signal: TradingSignal): string {
  const score = Number.isFinite(signal.score) ? `${signal.score}/12` : "n/a";
  return `• ${signal.ticker} (${score}) → ${signal.action}${signal.reason ? ` | ${signal.reason}` : ""}`;
}

function failCloseScan(scan: ScanResult, reason: string): ScanResult {
  const rewrittenSignals = scan.signals.map((signal) => ({ ...signal, action: "NO_BUY" as const, reason }));
  return {
    ...scan,
    signals: rewrittenSignals,
    blockedByGuards: rewrittenSignals.length,
    failClosed: true,
    failClosedReason: reason,
    guardNotes: [...(scan.guardNotes ?? []), `Fail-closed: ${reason}`],
  };
}

function applyFailClosedPolicy(scans: ScanResult[]): ScanResult[] {
  return scans.map((scan) => {
    if (!scan.marketRegime) {
      return failCloseScan(scan, "missing market regime in scanner output");
    }
    if (!scan.statusLine) {
      return failCloseScan(scan, "missing status line in scanner output");
    }
    if (scan.candidatesEvaluated > 0 && scan.thresholdPassed <= 0) {
      return failCloseScan(scan, "summary counts inconsistent (evaluated>0 but threshold-passed=0)");
    }
    return scan;
  });
}

function decisionStateFromCounts(buy: number, watch: number): DecisionState {
  if (buy > 0) return "BUY";
  if (watch > 0) return "WATCH";
  return "NO_TRADE";
}

function confidenceAndRiskFor(state: DecisionState, correctionMode: boolean, failClosed: boolean): { confidence: number; risk: "LOW" | "MEDIUM" | "HIGH" } {
  if (failClosed) return { confidence: 0.95, risk: "LOW" };
  if (state === "BUY") return { confidence: correctionMode ? 0.61 : 0.74, risk: correctionMode ? "HIGH" : "MEDIUM" };
  if (state === "WATCH") return { confidence: 0.8, risk: correctionMode ? "MEDIUM" : "LOW" };
  return { confidence: 0.9, risk: "LOW" };
}

function applyCorrectionGuards(scans: ScanResult[]): ScanResult[] {
  const { dipMaxBuys, dipMinBuyScore } = getCorrectionProfile();

  return scans.map((scan) => {
    const isCorrection = scan.marketRegime === "correction";
    if (!isCorrection) return scan;
    const guardNotes: string[] = [];
    let blockedByGuards = 0;

    if (scan.name === "CANSLIM") {
      const rewritten = scan.signals.map((signal) => {
        if (signal.action !== "BUY") return signal;
        blockedByGuards += 1;
        return {
          ...signal,
          action: "NO_BUY" as const,
          reason: "CANSLIM correction hard gate (execution blocked)",
        };
      });

      if (blockedByGuards > 0) {
        guardNotes.push(`CANSLIM hard gate blocked ${blockedByGuards} BUY signal(s) in correction.`);
      }

      return { ...scan, signals: rewritten, blockedByGuards, guardNotes };
    }

    if (scan.name === "Dip Buyer") {
      const buys = scan.signals
        .map((signal, idx) => ({ signal, idx }))
        .filter((x) => x.signal.action === "BUY")
        .sort((a, b) => (b.signal.score ?? -1) - (a.signal.score ?? -1));

      const allowedIndices = new Set<number>();
      for (const item of buys) {
        if (!Number.isFinite(item.signal.score) || (item.signal.score ?? 0) < dipMinBuyScore) continue;
        if (allowedIndices.size >= dipMaxBuys) continue;
        allowedIndices.add(item.idx);
      }

      const rewritten = scan.signals.map((signal, idx) => {
        if (signal.action !== "BUY") return signal;
        if (allowedIndices.has(idx)) return signal;
        blockedByGuards += 1;
        const baseReason =
          !Number.isFinite(signal.score) || (signal.score ?? 0) < dipMinBuyScore
            ? `Correction cap: BUY requires score >= ${dipMinBuyScore}/12`
            : `Correction cap: max ${dipMaxBuys} BUY signal(s)`;
        return {
          ...signal,
          action: "WATCH" as const,
          reason: baseReason,
        };
      });

      guardNotes.push(`Dip correction profile: max BUY=${dipMaxBuys}, min BUY score=${dipMinBuyScore}/12.`);
      if (blockedByGuards > 0) {
        guardNotes.push(`Dip correction caps downgraded ${blockedByGuards} BUY signal(s) to WATCH.`);
      }

      return { ...scan, signals: rewritten, blockedByGuards, guardNotes };
    }

    return scan;
  });
}

function topBlocker(scan: ScanResult): string {
  const emitted = scan.signals.filter((s) => s.action !== "NO_BUY").length;
  if (emitted > 0) return "n/a";

  if (scan.candidatesEvaluated === 0) {
    return "No symbols passed scanner threshold.";
  }

  const reasonCounts = new Map<string, number>();
  for (const signal of scan.signals) {
    const key = (signal.reason || "No reason provided.").trim();
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }

  if (reasonCounts.size === 0) {
    return "All candidates were NO_BUY.";
  }

  const [reason, count] = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `${reason} (${count})`;
}

function formatStrategySection(scan: ScanResult): string[] {
  const split = summarizeSignals(scan.signals);
  const emitted = split.buy.length + split.watch.length;
  const lines = [
    `${scan.name}: scanned ${scan.scanned || scan.scanLimit} | evaluated ${scan.candidatesEvaluated} | threshold-passed ${scan.thresholdPassed} | emitted BUY ${split.buy.length} / WATCH ${split.watch.length} / NO_BUY ${split.noBuy.length}`,
  ];

  if (scan.dipProfileLine) {
    lines.push(scan.dipProfileLine);
  }

  if (scan.blockerLine) {
    lines.push(scan.blockerLine);
  }
  if (scan.blockerSamplesLine) {
    lines.push(scan.blockerSamplesLine);
  }

  if (emitted === 0) {
    lines.push(`Top blocker: ${topBlocker(scan)}`);
  }

  if ((scan.blockedByGuards ?? 0) > 0) {
    lines.push(`Guardrails: blocked/downgraded ${scan.blockedByGuards}`);
  }
  for (const note of scan.guardNotes ?? []) {
    lines.push(`Guardrails: ${note}`);
  }

  for (const group of [split.buy, split.watch, split.noBuy]) {
    for (const signal of group.slice(0, 4)) {
      lines.push(formatSignalLine(signal));
    }
  }

  return lines;
}

function buildRegimeGateLine(scans: ScanResult[]): string {
  const primary = scans.find((s) => s.marketLine)?.marketLine;
  const correctionMode = scans.some((s) => s.marketRegime === "correction");
  const status = scans.find((s) => s.statusLine)?.statusLine;
  const dip = scans.find((s) => s.name === "Dip Buyer");
  const gateBits = [dip?.macroGateLine, dip?.hyNoteLine, dip?.dipProfileLine].filter(Boolean).join(" | ");

  const parts = [
    `Regime/Gates: correction=${correctionMode ? "YES" : "NO"}`,
    primary ? primary.replace(/^Market:\s*/i, "") : undefined,
    status ? status.replace(/^Status:\s*/i, "") : undefined,
    gateBits || undefined,
  ].filter(Boolean);

  return parts.join(" | ");
}

function buildFinalReport(scans: ScanResult[], verdicts: CouncilVerdict[]): string {
  const allSignals = scans.flatMap((s) => s.signals);
  const buy = allSignals.filter((s) => s.action === "BUY").length;
  const watch = allSignals.filter((s) => s.action === "WATCH").length;
  const noBuy = allSignals.filter((s) => s.action === "NO_BUY").length;

  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: true });
  const marketLines = scans.map((s) => s.marketLine).filter(Boolean) as string[];
  const correctionMode = scans.some((s) => s.marketRegime === "correction");
  const symbolsScanned = scans.reduce((sum, s) => sum + (s.scanned || s.scanLimit), 0);
  const candidatesEvaluated = scans.reduce((sum, s) => sum + s.candidatesEvaluated, 0);
  const blockedByGuards = scans.reduce((sum, s) => sum + (s.blockedByGuards ?? 0), 0);
  const failClosedScans = scans.filter((s) => s.failClosed);
  const decisionState = decisionStateFromCounts(buy, watch);
  const metrics = confidenceAndRiskFor(decisionState, correctionMode, failClosedScans.length > 0);
  const noTradeReason =
    decisionState === "NO_TRADE"
      ? (failClosedScans[0]?.failClosedReason
        ? `Fail-closed: ${failClosedScans[0].failClosedReason}`
        : (scans.map((scan) => topBlocker(scan)).find((x) => x && x !== "n/a") ?? "No qualifying setups met strategy gates."))
      : undefined;

  const lines: string[] = [
    "📈 Trading Advisor - Unified Pipeline",
    `Run: ${now} ET`,
    ...marketLines,
    buildRegimeGateLine(scans),
    `Diagnostics: symbols scanned ${symbolsScanned} | candidates evaluated ${candidatesEvaluated}`,
    `Blocker telemetry: guardrail blocks/downgrades ${blockedByGuards}`,
    `Decision: ${decisionState}`,
    `Confidence: ${metrics.confidence.toFixed(2)} | Risk: ${metrics.risk}`,
    noTradeReason ? `No-trade reason: ${noTradeReason}` : undefined,
    failClosedScans.length > 0 ? `Fail-closed scans: ${failClosedScans.map((s) => s.name).join(", ")}` : undefined,
    `Summary: BUY ${buy} | WATCH ${watch} | NO_BUY ${noBuy}`,
    "",
  ].filter(Boolean) as string[];

  for (const scan of scans) {
    lines.push(...formatStrategySection(scan), "");
  }

  if (verdicts.length > 0) {
    lines.push("🏛️ Council (BUY signals only):");
    for (const verdict of verdicts) {
      lines.push(
        `• ${verdict.ticker}: ${verdict.approved ? "APPROVED" : "REJECTED"} (${verdict.approveCount}/${verdict.totalVotes}, conf ${verdict.avgConfidence.toFixed(2)})`,
      );
      lines.push(`  ${verdict.synthesis}`);
    }
    lines.push("");
  }

  if (correctionMode) {
    const shadowWatch = allSignals
      .filter((s) => s.action === "WATCH")
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, 5);

    lines.push("👁️ Shadow Mode (Correction): top WATCH only, no execution changes");
    if (!shadowWatch.length) {
      lines.push("• No WATCH candidates right now.");
    } else {
      shadowWatch.forEach((signal) => lines.push(formatSignalLine(signal)));
    }
    lines.push("");
  }

  lines.push("⚠️ Decision support only — strict risk gates unchanged.");
  return lines.join("\n").trim();
}

export async function runTradingPipeline(deps?: Partial<PipelineDeps>): Promise<string> {
  const runCommand = deps?.runCommand ?? defaultRunCommand;
  const council = deps?.council ?? (async (alertText: string) => runTradingCouncil(alertText));

  loadBacktesterEnv();
  ensurePythonModuleAvailable("dotenv", { optional: true });
  ensureFredApiKey();

  const canslimLimit = getScanLimit("CANSLIM");
  const dipLimit = getScanLimit("Dip Buyer");

  const canslimOutput = runCommand("python3", ["canslim_alert.py", "--limit", String(canslimLimit), "--min-score", "6"]);
  const dipOutput = runCommand("python3", ["dipbuyer_alert.py", "--limit", String(dipLimit), "--min-score", "6"]);

  const canslimSummary = parseSummaryCounts(canslimOutput);
  const dipSummary = parseSummaryCounts(dipOutput);
  const dipDiagnostics = parseDipDiagnostics(dipOutput);

  const scanOutputs: ScanResult[] = [
    {
      name: "CANSLIM",
      output: canslimOutput,
      signals: parseSignals(canslimOutput),
      scanLimit: canslimLimit,
      ...canslimSummary,
      ...parseMarketLine(canslimOutput),
      ...parseCommonDiagnostics(canslimOutput),
    },
    {
      name: "Dip Buyer",
      output: dipOutput,
      signals: parseSignals(dipOutput),
      scanLimit: dipLimit,
      ...dipSummary,
      ...dipDiagnostics,
      ...parseMarketLine(dipOutput),
      ...parseCommonDiagnostics(dipOutput),
    },
  ];

  const failClosedOutputs = applyFailClosedPolicy(scanOutputs);
  const guardedOutputs = applyCorrectionGuards(failClosedOutputs);

  const councilVerdicts: CouncilVerdict[] = [];
  for (const scan of guardedOutputs) {
    if (!scan.signals.some((s) => s.action === "BUY")) continue;
    const result = await council(scan.output);
    councilVerdicts.push(...result.verdicts);
  }

  return buildFinalReport(guardedOutputs, councilVerdicts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTradingPipeline()
    .then((report) => console.log(report))
    .catch((error) => {
      console.error(`📈 Trading Advisor - Error: ${(error as Error).message}`);
      process.exit(1);
    });
}
