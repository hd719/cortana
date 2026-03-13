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

    expect(alert).toContain("📈 Trading Advisor - Market Session Snapshot");
    expect(alert).toContain("Decision: WATCH | 0.80 | Risk: MEDIUM");
    expect(alert).toContain("CANSLIM: BUY 0 | WATCH 1 | NO_BUY 0");
    expect(alert).toContain("Dip Buyer: BUY 0 | WATCH 1 | NO_BUY 0");
    expect(alert).toContain("Focus: CANSLIM AAPL WATCH | Dip TSLA WATCH");
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

    expect(alert).toContain("Decision: NO_TRADE | 0.90 | Risk: LOW");
    expect(alert).toContain("Reason: Fail-closed: missing market regime in scanner output");
  });
});
