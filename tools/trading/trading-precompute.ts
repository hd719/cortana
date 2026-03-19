#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveBacktesterCwd, resolvePythonBin } from "./trading-cron-alert";

const DEFAULT_DISCOVERY_LIMIT = Number(process.env.TRADING_PRECOMPUTE_DISCOVERY_LIMIT || "20");
const DEFAULT_TIMEOUT_MS = Number(process.env.TRADING_PRECOMPUTE_TIMEOUT_MS || "600000");

type JsonObject = Record<string, unknown>;

export type FeatureSnapshotSummary = {
  symbolCount: number;
  generatedAt: string | null;
  source: string | null;
};

export type CalibrationArtifactSummary = {
  status: "fresh" | "stale" | "unknown";
  reason: string | null;
  settledCandidates: number;
  generatedAt: string | null;
};

export type TradingPrecomputeSummary = {
  featureSnapshot: FeatureSnapshotSummary;
  liquiditySymbolCount: number;
  settledCount: number;
  calibration: CalibrationArtifactSummary;
};

function runPythonJson(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): unknown {
  const result = spawnSync(resolvePythonBin(), args, {
    cwd: resolveBacktesterCwd(),
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `python command failed: ${args.join(" ")}`).trim());
  }

  const stdout = (result.stdout || "").trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`failed to parse JSON from ${args[0]}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function summarizeNightlyDiscoveryReport(value: unknown): {
  featureSnapshot: FeatureSnapshotSummary;
  liquiditySymbolCount: number;
} {
  const payload = asObject(value);
  const snapshot = asObject(payload.feature_snapshot);
  const liquidity = asObject(payload.liquidity_overlay);
  return {
    featureSnapshot: {
      symbolCount: asNumber(snapshot.symbol_count),
      generatedAt: typeof snapshot.generated_at === "string" ? snapshot.generated_at : null,
      source: typeof snapshot.source === "string" ? snapshot.source : null,
    },
    liquiditySymbolCount: asNumber(liquidity.symbol_count),
  };
}

export function summarizeCalibrationArtifact(value: unknown): CalibrationArtifactSummary {
  const payload = asObject(value);
  const freshness = asObject(payload.freshness);
  const summary = asObject(payload.summary);
  const stale = freshness.is_stale === true;
  return {
    status: freshness.is_stale === true ? "stale" : freshness.is_stale === false ? "fresh" : "unknown",
    reason: typeof freshness.reason === "string" ? freshness.reason : null,
    settledCandidates: asNumber(summary.settled_candidates),
    generatedAt: typeof payload.generated_at === "string" ? payload.generated_at : null,
  };
}

export function buildTradingPrecomputeSummary(
  options: {
    discoveryLimit?: number;
    timeoutMs?: number;
    runJson?: (args: string[], timeoutMs?: number) => unknown;
  } = {},
): TradingPrecomputeSummary {
  const runJson = options.runJson ?? runPythonJson;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const discoveryLimit = options.discoveryLimit ?? DEFAULT_DISCOVERY_LIMIT;

  const nightly = summarizeNightlyDiscoveryReport(
    runJson(["nightly_discovery.py", "--limit", String(discoveryLimit), "--json"], timeoutMs),
  );
  const settled = runJson(["experimental_alpha.py", "--settle", "--json"], timeoutMs);
  const calibration = summarizeCalibrationArtifact(runJson(["buy_decision_calibration.py", "--json"], timeoutMs));

  return {
    featureSnapshot: nightly.featureSnapshot,
    liquiditySymbolCount: nightly.liquiditySymbolCount,
    settledCount: Array.isArray(settled) ? settled.length : 0,
    calibration,
  };
}

export function formatTradingPrecomputeSummary(summary: TradingPrecomputeSummary): string {
  const snapshotAt = summary.featureSnapshot.generatedAt || "unknown";
  const calibrationAt = summary.calibration.generatedAt || "unknown";
  return [
    "Trading precompute complete",
    `Feature snapshot: ${summary.featureSnapshot.symbolCount} symbols | ${snapshotAt}`,
    `Liquidity overlay: ${summary.liquiditySymbolCount} symbols`,
    `Settled research candidates: ${summary.settledCount}`,
    `Calibration: ${summary.calibration.status} | settled ${summary.calibration.settledCandidates} | ${calibrationAt}${summary.calibration.reason ? ` | ${summary.calibration.reason}` : ""}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const summary = buildTradingPrecomputeSummary();
  console.log(formatTradingPrecomputeSummary(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
