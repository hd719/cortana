import { describe, expect, it } from "vitest";
import { buildFullWatchlistArtifact, formatFullWatchlistArtifactText } from "../../tools/trading/backtest-compute";

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
});
