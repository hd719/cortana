#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { parseSignals, runTradingCouncil, type CouncilVerdict, type TradingSignal } from "../council/trading-council";

const DEFAULT_SCAN_LIMIT = 120;

interface ScanResult {
  name: "CANSLIM" | "Dip Buyer";
  output: string;
  signals: TradingSignal[];
  marketRegime?: string;
  marketLine?: string;
  statusLine?: string;
  macroGateLine?: string;
  hyNoteLine?: string;
  candidatesEvaluated: number;
  scanLimit: number;
}

interface PipelineDeps {
  runCommand: (command: string, args: string[]) => string;
  council: (alertText: string) => Promise<{ verdicts: CouncilVerdict[] }>;
}

function defaultRunCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: "/Users/hd/Developer/cortana-external/backtester",
    encoding: "utf8",
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

function parseSummaryCounts(text: string): { candidatesEvaluated: number } {
  const summaryLine = text.split(/\r?\n/).find((l) => l.startsWith("Summary:"));
  const candidatesEvaluated = Number(summaryLine?.match(/Summary:\s*(\d+)\s+candidates/i)?.[1] ?? 0);
  return { candidatesEvaluated };
}

function parseDipDiagnostics(text: string): { macroGateLine?: string; hyNoteLine?: string } {
  const lines = text.split(/\r?\n/);
  return {
    macroGateLine: lines.find((l) => l.startsWith("Macro Gate:")),
    hyNoteLine: lines.find((l) => l.startsWith("HY Note:")),
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

function formatSignalLine(signal: TradingSignal): string {
  const score = Number.isFinite(signal.score) ? `${signal.score}/12` : "n/a";
  return `• ${signal.ticker} (${score}) → ${signal.action}${signal.reason ? ` | ${signal.reason}` : ""}`;
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
    `${scan.name}: scanned ${scan.scanLimit} | evaluated ${scan.candidatesEvaluated} | threshold-passed ${scan.candidatesEvaluated} | emitted BUY ${split.buy.length} / WATCH ${split.watch.length} / NO_BUY ${split.noBuy.length}`,
  ];

  if (emitted === 0) {
    lines.push(`Top blocker: ${topBlocker(scan)}`);
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
  const gateBits = [dip?.macroGateLine, dip?.hyNoteLine].filter(Boolean).join(" | ");

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
  const symbolsScanned = scans.reduce((sum, s) => sum + s.scanLimit, 0);
  const candidatesEvaluated = scans.reduce((sum, s) => sum + s.candidatesEvaluated, 0);

  const lines: string[] = [
    "📈 Trading Advisor - Unified Pipeline",
    `Run: ${now} ET`,
    ...marketLines,
    buildRegimeGateLine(scans),
    `Diagnostics: symbols scanned ${symbolsScanned} | candidates evaluated ${candidatesEvaluated}`,
    `Summary: BUY ${buy} | WATCH ${watch} | NO_BUY ${noBuy}`,
    "",
  ];

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
    },
    {
      name: "Dip Buyer",
      output: dipOutput,
      signals: parseSignals(dipOutput),
      scanLimit: dipLimit,
      ...dipSummary,
      ...dipDiagnostics,
      ...parseMarketLine(dipOutput),
    },
  ];

  const councilVerdicts: CouncilVerdict[] = [];
  for (const scan of scanOutputs) {
    if (!scan.signals.some((s) => s.action === "BUY")) continue;
    const result = await council(scan.output);
    councilVerdicts.push(...result.verdicts);
  }

  return buildFinalReport(scanOutputs, councilVerdicts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTradingPipeline()
    .then((report) => console.log(report))
    .catch((error) => {
      console.error(`📈 Trading Advisor - Error: ${(error as Error).message}`);
      process.exit(1);
    });
}
