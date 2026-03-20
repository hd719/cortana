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
});
