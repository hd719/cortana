#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { parseSignals, runTradingCouncil, type CouncilVerdict, type TradingSignal } from "../council/trading-council";

interface ScanResult {
  name: "CANSLIM" | "Dip Buyer";
  output: string;
  signals: TradingSignal[];
  marketRegime?: string;
  marketLine?: string;
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

function parseMarketLine(text: string): { marketRegime?: string; marketLine?: string } {
  const marketLine = text.split(/\r?\n/).find((l) => l.startsWith("Market:"));
  if (!marketLine) return {};
  const marketRegime = marketLine.match(/^Market:\s*([^|]+)/i)?.[1]?.trim().toLowerCase();
  return { marketRegime, marketLine };
}

function formatSignalLine(signal: TradingSignal): string {
  const score = Number.isFinite(signal.score) ? `${signal.score}/12` : "n/a";
  return `• ${signal.ticker} (${score}) → ${signal.action}${signal.reason ? ` | ${signal.reason}` : ""}`;
}

function formatStrategySection(scan: ScanResult): string[] {
  const split = summarizeSignals(scan.signals);
  const lines = [
    `${scan.name}: BUY ${split.buy.length} | WATCH ${split.watch.length} | NO_BUY ${split.noBuy.length}`,
  ];

  for (const group of [split.buy, split.watch, split.noBuy]) {
    for (const signal of group.slice(0, 4)) {
      lines.push(formatSignalLine(signal));
    }
  }

  return lines;
}

function buildFinalReport(scans: ScanResult[], verdicts: CouncilVerdict[]): string {
  const allSignals = scans.flatMap((s) => s.signals);
  const buy = allSignals.filter((s) => s.action === "BUY").length;
  const watch = allSignals.filter((s) => s.action === "WATCH").length;
  const noBuy = allSignals.filter((s) => s.action === "NO_BUY").length;

  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: true });
  const marketLines = scans.map((s) => s.marketLine).filter(Boolean) as string[];
  const correctionMode = scans.some((s) => s.marketRegime === "correction");

  const lines: string[] = [
    "📈 Trading Advisor - Unified Pipeline",
    `Run: ${now} ET`,
    ...marketLines,
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

  const canslimOutput = runCommand("python3", ["canslim_alert.py", "--limit", "8", "--min-score", "6"]);
  const dipOutput = runCommand("python3", ["dipbuyer_alert.py", "--limit", "8", "--min-score", "6"]);

  const scanOutputs: ScanResult[] = [
    { name: "CANSLIM", output: canslimOutput, signals: parseSignals(canslimOutput), ...parseMarketLine(canslimOutput) },
    { name: "Dip Buyer", output: dipOutput, signals: parseSignals(dipOutput), ...parseMarketLine(dipOutput) },
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
