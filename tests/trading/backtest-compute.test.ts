import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildFullWatchlistArtifact,
  buildFullWatchlistArtifactFromSnapshot,
  extractUnifiedMetricsFromSnapshot,
  formatFullWatchlistArtifactText,
} from "../../tools/trading/backtest-compute";
import type { PipelineSnapshot } from "../../tools/trading/trading-pipeline";
import { cleanupTestTempDirs, createTestTempDir } from "./test-temp-artifacts";

const tempRoots = new Set<string>();

afterEach(() => {
  cleanupTestTempDirs(tempRoots);
});

const UNIFIED_REPORT = `📈 Trading Advisor - Unified Pipeline
Run: 3/19/2026, 3:30:00 PM ET
Market: correction | Position Sizing: 0%
Regime/Gates: correction=YES | correction | 7 distribution days. Reduce exposure.
Diagnostics: symbols scanned 240 | candidates evaluated 18
Decision: BUY
Confidence: 0.61 | Risk: HIGH
Summary: BUY 1 | WATCH 4 | NO_BUY 1

CANSLIM: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 1 / NO_BUY 1
• AAPL (7/12) → WATCH
• AMD (6/12) → NO_BUY

Dip Buyer: scanned 120 | evaluated 5 | threshold-passed 5 | emitted BUY 1 / WATCH 3 / NO_BUY 0
• ARES (10/12) → BUY
• ALGN (7/12) → WATCH
• AEP (8/12) → WATCH
• AXON (9/12) → BUY | compact summary
• AXON (9/12) → WATCH | final correction cap

⚠️ Decision support only — strict risk gates unchanged.`;

const BLOCKER_PREFACED_REPORT = `📈 Trading Advisor - Unified Pipeline
Run: 3/20/2026, 11:30:29 AM ET
Market: correction — no new positions
Regime/Gates: correction=YES | correction — no new positions | unavailable
Decision: WATCH
Confidence: 0.80 | Risk: MEDIUM
Summary: BUY 0 | WATCH 4 | NO_BUY 1

CANSLIM: scanned 120 | evaluated 0 | threshold-passed 0 | emitted BUY 0 / WATCH 0 / NO_BUY 0

Dip Buyer: scanned 120 | evaluated 120 | threshold-passed 6 | emitted BUY 0 / WATCH 4 / NO_BUY 1
Blockers: NO_BUY 1
Guardrails: Dip correction profile: max BUY=1, min BUY score=8/12.
• ACN (8/12) → WATCH | • ALGN (7/12) → WATCH | Parsed from compact leader summary
• ALGN (7/12) → WATCH | • ARES (10/12) → WATCH | Parsed from compact leader summary
• ARES (10/12) → WATCH | • AMD (9/12) → WATCH | Parsed from compact leader summary
• BMRN (11/12) → NO_BUY | Parsed from compact leader summary

👁️ Shadow Mode (Correction): top WATCH only, no execution changes
• ARES (10/12) → WATCH | • AMD (9/12) → WATCH | Parsed from compact leader summary

⚠️ Decision support only — strict risk gates unchanged.`;

const PIPELINE_SNAPSHOT: PipelineSnapshot = {
  decision: "BUY",
  confidence: 0.61,
  risk: "HIGH",
  correctionMode: true,
  regimeGates: "Regime/Gates: correction=YES | correction | 7 distribution days. Reduce exposure.",
  summary: { buy: 1, watch: 4, noBuy: 1 },
  strategies: {
    canslim: {
      outcomeClass: "healthy_candidates_found",
      scanned: 120,
      evaluated: 1,
      thresholdPassed: 1,
      buy: 0,
      watch: 1,
      noBuy: 1,
      signals: [
        { ticker: "AAPL", score: 7, action: "WATCH", reason: "Watch setup", section: "CANSLIM" },
        { ticker: "AMD", score: 6, action: "NO_BUY", reason: "Below threshold", section: "CANSLIM" },
      ],
    },
    dipBuyer: {
      outcomeClass: "healthy_candidates_found",
      scanned: 120,
      evaluated: 5,
      thresholdPassed: 5,
      buy: 1,
      watch: 3,
      noBuy: 0,
      signals: [
        { ticker: "ARES", score: 10, action: "BUY", reason: "Setup", section: "Dip Buyer" },
        { ticker: "ALGN", score: 7, action: "WATCH", reason: "Watch", section: "Dip Buyer" },
        { ticker: "AEP", score: 8, action: "WATCH", reason: "Watch", section: "Dip Buyer" },
        { ticker: "AXON", score: 9, action: "WATCH", reason: "Final correction cap", section: "Dip Buyer" },
      ],
    },
  },
  guardrailCount: 1,
  relatedDetections: 18,
  calibration: null,
  failClosedScans: [],
};

describe("backtest compute watchlist artifacts", () => {
  it("builds a full watchlist artifact from the final post-guard signal set", () => {
    const artifact = buildFullWatchlistArtifact("20260319-211220", UNIFIED_REPORT, "2026-03-19T21:12:20.000Z");

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.schema_version).toBe(1);
    expect(artifact.runId).toBe("20260319-211220");
    expect(artifact.run_id).toBe("20260319-211220");
    expect(artifact.decision).toBe("BUY");
    expect(artifact.correctionMode).toBe(true);
    expect(artifact.summary).toEqual({ buy: 1, watch: 4, noBuy: 1 });
    expect(artifact.focus).toEqual({
      ticker: "ARES",
      score: 10,
      action: "BUY",
      strategy: "Dip Buyer",
    });
    expect(artifact.strategies.canslim.watch.map((entry) => entry.ticker)).toEqual(["AAPL"]);
    expect(artifact.strategies.canslim.noBuy.map((entry) => entry.ticker)).toEqual(["AMD"]);
    expect(artifact.strategies.dipBuyer.buy.map((entry) => entry.ticker)).toEqual(["ARES"]);
    expect(artifact.strategies.dipBuyer.watch.map((entry) => entry.ticker)).toEqual(["ALGN", "AEP", "AXON"]);
  });

  it("formats a readable full watchlist text artifact", () => {
    const artifact = buildFullWatchlistArtifact("20260319-211220", UNIFIED_REPORT, "2026-03-19T21:12:20.000Z");
    const text = formatFullWatchlistArtifactText(artifact);

    expect(text).toContain("Trading Watchlist - Full");
    expect(text).toContain("Run: 20260319-211220");
    expect(text).toContain("Summary: BUY 1 | WATCH 4 | NO_BUY 1");
    expect(text).toContain("Focus: ARES 10/12 → BUY (Dip Buyer)");
    expect(text).toContain("Dip Buyer WATCH (3): ALGN 7/12 · AEP 8/12 · AXON 9/12");
    expect(text).toContain("CANSLIM NO_BUY (1): AMD 6/12");
  });

  it("captures watch signals when blocker lines appear before detailed bullets", () => {
    const artifact = buildFullWatchlistArtifact("20260320-152401", BLOCKER_PREFACED_REPORT, "2026-03-20T15:30:29.817Z");

    expect(artifact.summary).toEqual({ buy: 0, watch: 4, noBuy: 1 });
    expect(artifact.strategies.dipBuyer.watch.map((entry) => entry.ticker)).toEqual(["ACN", "ALGN", "ARES", "AMD"]);
    expect(artifact.strategies.dipBuyer.noBuy.map((entry) => entry.ticker)).toEqual(["BMRN"]);
  });

  it("builds the same full watchlist artifact from a typed pipeline snapshot", () => {
    const fromReport = buildFullWatchlistArtifact("20260319-211220", UNIFIED_REPORT, "2026-03-19T21:12:20.000Z");
    const fromSnapshot = buildFullWatchlistArtifactFromSnapshot("20260319-211220", PIPELINE_SNAPSHOT, "2026-03-19T21:12:20.000Z");

    expect(fromSnapshot).toMatchObject({
      schemaVersion: fromReport.schemaVersion,
      decision: fromReport.decision,
      correctionMode: fromReport.correctionMode,
      summary: fromReport.summary,
      focus: fromReport.focus,
      strategies: {
        canslim: {
          outcomeClass: "healthy_candidates_found",
          buy: fromReport.strategies.canslim.buy,
          watch: fromReport.strategies.canslim.watch,
          noBuy: fromReport.strategies.canslim.noBuy,
        },
        dipBuyer: {
          outcomeClass: "healthy_candidates_found",
          buy: fromReport.strategies.dipBuyer.buy,
          watch: fromReport.strategies.dipBuyer.watch,
          noBuy: fromReport.strategies.dipBuyer.noBuy,
        },
      },
    });
  });

  it("preserves per-strategy outcome classes when artifact is built from snapshot", () => {
    const outcomeBlockedSnapshot: typeof PIPELINE_SNAPSHOT = {
      ...PIPELINE_SNAPSHOT,
      strategies: {
        ...PIPELINE_SNAPSHOT.strategies,
        canslim: {
          ...PIPELINE_SNAPSHOT.strategies.canslim,
          outcomeClass: "analysis_failed",
          scanned: 120,
          evaluated: 0,
          thresholdPassed: 0,
          signals: [],
          buy: 0,
          watch: 0,
          noBuy: 0,
        },
        dipBuyer: {
          ...PIPELINE_SNAPSHOT.strategies.dipBuyer,
          outcomeClass: "market_gate_blocked",
          scanned: 120,
          evaluated: 0,
          thresholdPassed: 0,
          signals: [],
          buy: 0,
          watch: 0,
          noBuy: 0,
        },
      },
    };

    const fromSnapshot = buildFullWatchlistArtifactFromSnapshot(
      "20260319-211220",
      outcomeBlockedSnapshot,
      "2026-03-19T21:12:20.000Z",
    );

    expect(fromSnapshot.strategies.canslim.outcomeClass).toBe("analysis_failed");
    expect(fromSnapshot.strategies.dipBuyer.outcomeClass).toBe("market_gate_blocked");
    expect(formatFullWatchlistArtifactText(fromSnapshot)).toContain("CANSLIM status: analysis failed");
    expect(formatFullWatchlistArtifactText(fromSnapshot)).toContain("Dip Buyer status: market gate blocked");
  });
});

describe("backtest compute unified metrics", () => {
  it("extracts the same unified metric set from a typed pipeline snapshot", () => {
    const metrics = extractUnifiedMetricsFromSnapshot(PIPELINE_SNAPSHOT);

    expect(metrics).toEqual({
      decision: "BUY",
      confidence: 0.61,
      risk: "HIGH",
      correctionMode: true,
      buy: 1,
      watch: 4,
      noBuy: 1,
      symbolsScanned: 240,
      candidatesEvaluated: 18,
      canslimScanned: 120,
      canslimEvaluated: 1,
      canslimThresholdPassed: 1,
      canslimBuy: 0,
      canslimWatch: 1,
      canslimNoBuy: 1,
      dipBuyerScanned: 120,
      dipBuyerEvaluated: 5,
      dipBuyerThresholdPassed: 5,
      dipBuyerBuy: 1,
      dipBuyerWatch: 3,
      dipBuyerNoBuy: 0,
    });
  });
});

describe("backtest compute failure artifacts", () => {
  it("writes structured failure details and emits a concise stderr summary", () => {
    const root = createTestTempDir("backtest-compute-", tempRoots);
    const scriptPath = path.join(root, "fail.sh");
    const psqlStub = path.join(root, "psql-stub.sh");
    const psqlLog = path.join(root, "psql.log");
    mkdirSync(path.join(root, "runs"), { recursive: true });
    writeFileSync(
      scriptPath,
      "#!/usr/bin/env bash\n>&2 echo 'Market regime refresh failed: transient provider cooldown while fetching SPY 90d.'\nexit 1\n",
      { mode: 0o755 },
    );
    writeFileSync(
      psqlStub,
      `#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> '${psqlLog}'\nexit 0\n`,
      { mode: 0o755 },
    );

    let stderr = "";
    try {
      execSync(
        `BACKTEST_ROOT_DIR=${root} BACKTEST_CWD=${root} BACKTEST_COMPUTE_COMMAND='${scriptPath}' MISSION_CONTROL_DATABASE_URL='postgresql://writer@localhost:5432/mission_control' PSQL_BIN='${psqlStub}' node --import tsx ./tools/trading/backtest-compute.ts`,
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
      );
    } catch (error: any) {
      stderr = String(error?.stderr || "");
    }

    const runDirs = readdirSync(path.join(root, "runs"));
    expect(runDirs.length).toBe(1);
    const summaryPath = path.join(root, "runs", runDirs[0], "summary.json");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const message = readFileSync(path.join(root, "runs", runDirs[0], "message.txt"), "utf8");

    expect(summary.status).toBe("failed");
    expect(summary.error.summary).toBe("Market regime refresh failed: transient SPY 90d provider cooldown blocked the scan.");
    expect(summary.error.stage).toBe("market-regime");
    expect(summary.error.transient).toBe(true);
    expect(message).toContain("Run failed.");
    expect(message).toContain("Market regime refresh failed: transient SPY 90d provider cooldown blocked the scan.");
    expect(stderr).toContain("FAILED_BACKTEST_SUMMARY");
    expect(stderr).toContain("stage=market-regime");
    const syncLog = readFileSync(psqlLog, "utf8");
    expect(syncLog).toContain("mc_trading_runs");
    expect(syncLog).toContain("'running'");
    expect(syncLog).toContain("'failed'");
  });
});
