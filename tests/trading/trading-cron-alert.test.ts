import { describe, expect, it } from "vitest";
import { applyTradingCronReliabilityDefaults, buildCronAlertFromPipelineReport } from "../../tools/trading/trading-cron-alert";

describe("trading cron alert formatter", () => {
  it("applies chunked scan defaults for the live cron path without overwriting explicit env", () => {
    const env: NodeJS.ProcessEnv = {
      TRADING_SCAN_CHUNK_SIZE_CANSLIM: "",
      TRADING_SCAN_CHUNK_PARALLELISM_CANSLIM: "4",
    };

    applyTradingCronReliabilityDefaults(env);

    expect(env.TRADING_SCAN_CHUNK_SIZE_CANSLIM).toBe("20");
    expect(env.TRADING_SCAN_CHUNK_PARALLELISM_CANSLIM).toBe("4");
    expect(env.TRADING_SCAN_CHUNK_SIZE_DIP).toBe("20");
    expect(env.TRADING_SCAN_CHUNK_PARALLELISM_DIP).toBe("2");
  });

  it("builds a compact combined CANSLIM and Dip Buyer alert", () => {
    const report = `📈 Trading Advisor - Unified Pipeline
Run: 3/13/2026, 3:30:00 PM ET
Market: correction | Position Sizing: 0%
Regime/Gates: correction=YES | correction | 7 distribution days. Reduce exposure. | Macro Gate: OPEN | VIX 23 | PCR 1.07 | HY 450 bps (fred)
Diagnostics: symbols scanned 240 | candidates evaluated 2
Blocker telemetry: guardrail blocks/downgrades 1
Decision: WATCH
Confidence: 0.80 | Risk: MEDIUM
Summary: BUY 0 | WATCH 2 | NO_BUY 0

CANSLIM: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 1 / NO_BUY 0
• AAPL (7/12) → WATCH

Dip Buyer: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 1 / NO_BUY 0
• TSLA (8/12) → WATCH

⚠️ Decision support only — strict risk gates unchanged.`;

    const alert = buildCronAlertFromPipelineReport(report);

    expect(alert).toContain("📈 Trading Advisor — Market Snapshot");
    expect(alert).toContain("🎯 Decision: WATCH | Confidence: 0.80 | Risk: MEDIUM");
    expect(alert).toContain("│ BUY 0 │ WATCH 2 │ NO_BUY 0 │");
    expect(alert).toContain("│ CANSLIM: BUY 0 · WATCH 1 │");
    expect(alert).toContain("│ Dip Buyer: BUY 0 · WATCH 1 │");
    expect(alert).toContain("👀 Dip Buyer Watchlist (1):");
    expect(alert).toContain(" TSLA 8/12");
  });

  it("surfaces the no-trade reason when both strategies are blocked", () => {
    const report = `📈 Trading Advisor - Unified Pipeline
Decision: NO_TRADE
Confidence: 0.90 | Risk: LOW
Regime/Gates: correction=YES | correction
Summary: BUY 0 | WATCH 0 | NO_BUY 2
No-trade reason: Fail-closed: missing market regime in scanner output
CANSLIM: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 0 / NO_BUY 1
• NVDA (9/12) → NO_BUY
Dip Buyer: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 0 / NO_BUY 1
• TSLA (8/12) → NO_BUY`;

    const alert = buildCronAlertFromPipelineReport(report);

    expect(alert).toContain("🎯 Decision: NO_TRADE | Confidence: 0.90 | Risk: LOW");
    expect(alert).toContain("│ BUY 0 │ WATCH 0 │ NO_BUY 2 │");
  });

  it("adds a ranked watchlist when correction mode has WATCH candidates but no BUYs", () => {
    const report = `📈 Trading Advisor - Unified Pipeline
Decision: WATCH
Confidence: 0.80 | Risk: MEDIUM
Regime/Gates: correction=YES | correction | defensive
Summary: BUY 0 | WATCH 4 | NO_BUY 0
CANSLIM: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 1 / NO_BUY 0
• AAPL (7/12) → WATCH
Dip Buyer: scanned 120 | evaluated 3 | threshold-passed 3 | emitted BUY 0 / WATCH 3 / NO_BUY 0
• GOOGL (9/12) → WATCH
• NFLX (9/12) → WATCH
• MSFT (9/12) → WATCH`;

    const alert = buildCronAlertFromPipelineReport(report);

    expect(alert).toContain("👀 Dip Buyer Watchlist (3):");
    expect(alert).toContain(" GOOGL 9/12 · NFLX 9/12 · MSFT 9/12");
    expect(alert).toContain("👀 CANSLIM Watchlist (1):");
    expect(alert).toContain(" AAPL 7/12");
  });

  it("shows the full compact watchlist when the watch count is seven or fewer", () => {
    const report = `📈 Trading Advisor - Unified Pipeline
Decision: WATCH
Confidence: 0.61 | Risk: HIGH
Regime/Gates: correction=YES | correction
Summary: BUY 1 | WATCH 7 | NO_BUY 0
CANSLIM: scanned 120 | evaluated 0 | threshold-passed 0 | emitted BUY 0 / WATCH 0 / NO_BUY 0
Dip Buyer: scanned 120 | evaluated 8 | threshold-passed 8 | emitted BUY 1 / WATCH 7 / NO_BUY 0
• ARES (10/12) → BUY
• ALGN (7/12) → WATCH
• AEP (8/12) → WATCH
• ADSK (9/12) → WATCH
• ANET (7/12) → WATCH
• AMAT (7/12) → WATCH
• APP (8/12) → WATCH
• ARM (9/12) → WATCH`;

    const alert = buildCronAlertFromPipelineReport(report);

    expect(alert).toContain("👀 Dip Buyer Watchlist (7):");
    expect(alert).toContain(" ALGN 7/12 · AEP 8/12 · ADSK 9/12 · ANET 7/12 · AMAT 7/12 · APP 8/12 · ARM 9/12");
    expect(alert).not.toContain("[+");
  });

  it("collapses only genuinely large watchlists", () => {
    const report = `📈 Trading Advisor - Unified Pipeline
Decision: WATCH
Confidence: 0.61 | Risk: HIGH
Regime/Gates: correction=YES | correction
Summary: BUY 0 | WATCH 8 | NO_BUY 0
CANSLIM: scanned 120 | evaluated 0 | threshold-passed 0 | emitted BUY 0 / WATCH 0 / NO_BUY 0
Dip Buyer: scanned 120 | evaluated 8 | threshold-passed 8 | emitted BUY 0 / WATCH 8 / NO_BUY 0
• ALGN (7/12) → WATCH
• AEP (8/12) → WATCH
• ADSK (9/12) → WATCH
• ANET (7/12) → WATCH
• AMAT (7/12) → WATCH
• APP (8/12) → WATCH
• ARM (9/12) → WATCH
• AVGO (7/12) → WATCH`;

    const alert = buildCronAlertFromPipelineReport(report);

    expect(alert).toContain("👀 Dip Buyer Watchlist (8):");
    expect(alert).toContain(" ALGN 7/12 · AEP 8/12 · ADSK 9/12 · ANET 7/12 · AMAT 7/12 [+3 more]");
  });
});
