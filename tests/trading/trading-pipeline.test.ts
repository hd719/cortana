import { describe, expect, it, vi } from "vitest";
import { runTradingPipeline } from "../../tools/trading/trading-pipeline";

const CANSLIM_NO_BUY = `📈 Trading Advisor - CANSLIM Scan
Market: correction | Position Sizing: 0%
Summary: 1 candidates | BUY 0 | WATCH 1 | NO_BUY 0
• AAPL (7/12) → WATCH
  Watch setup`;

const DIP_NO_BUY = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 50%
Summary: 1 candidates | BUY 0 | WATCH 1 | NO_BUY 0
• TSLA (8/12) → WATCH
  Watch setup`;

const CANSLIM_BUY = `📈 Trading Advisor - CANSLIM Scan
Market: confirmed_uptrend | Position Sizing: 100%
Summary: 1 candidates | BUY 1 | WATCH 0 | NO_BUY 0
• NVDA (9/12) → BUY
  Entry $900.00 | Stop $855.00`;

const DIP_BUY = `📉 Trading Advisor - Dip Buyer Scan
Market: uptrend_under_pressure | Position Sizing: 50%
Summary: 1 candidates | BUY 1 | WATCH 0 | NO_BUY 0
• TSLA (8/12) → BUY
  Entry $200.00 | Stop $186.00`;

describe("trading pipeline orchestration", () => {
  it("does not call council when no BUY signals are present", async () => {
    const council = vi.fn(async () => ({ verdicts: [] }));

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : DIP_NO_BUY),
      council,
    });

    expect(council).not.toHaveBeenCalled();
    expect(report).toContain("Summary: BUY 0 | WATCH 2 | NO_BUY 0");
  });

  it("calls council when BUY signals are present", async () => {
    const council = vi.fn(async () => ({
      verdicts: [
        {
          ticker: "NVDA",
          sessionId: "s1",
          approved: true,
          approveCount: 2,
          totalVotes: 3,
          avgConfidence: 0.77,
          synthesis: "Momentum and risk vote to proceed with caution.",
        },
      ],
    }));

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_BUY : DIP_NO_BUY),
      council,
    });

    expect(council).toHaveBeenCalledTimes(1);
    expect(report).toContain("🏛️ Council (BUY signals only):");
    expect(report).toContain("NVDA: APPROVED");
  });

  it("shows correction shadow mode watch section", async () => {
    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : DIP_NO_BUY),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("👁️ Shadow Mode (Correction): top WATCH only, no execution changes");
    expect(report).toContain("AAPL");
    expect(report).toContain("TSLA");
  });

  it("calls council for each scanner that has BUY signals", async () => {
    const council = vi.fn(async () => ({ verdicts: [] }));

    await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_BUY : DIP_BUY),
      council,
    });

    expect(council).toHaveBeenCalledTimes(2);
  });

  it("limits correction shadow watchlist to top 5 by score across both scanners", async () => {
    const canslimWatchHeavy = `📈 Trading Advisor - CANSLIM Scan
Market: correction | Position Sizing: 0%
Summary: 4 candidates | BUY 0 | WATCH 4 | NO_BUY 0
• AAA (6/12) → WATCH
  Watch setup
• BBB (11/12) → WATCH
  Watch setup
• CCC (8/12) → WATCH
  Watch setup
• DDD (5/12) → WATCH
  Watch setup`;

    const dipWatchHeavy = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 50%
Summary: 4 candidates | BUY 0 | WATCH 4 | NO_BUY 0
• EEE (10/12) → WATCH
  Watch setup
• FFF (9/12) → WATCH
  Watch setup
• GGG (7/12) → WATCH
  Watch setup
• HHH (4/12) → WATCH
  Watch setup`;

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? canslimWatchHeavy : dipWatchHeavy),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("👁️ Shadow Mode (Correction): top WATCH only, no execution changes");
    const shadowSection = report.split("👁️ Shadow Mode (Correction): top WATCH only, no execution changes")[1] ?? "";

    expect(shadowSection).toContain("BBB (11/12) → WATCH");
    expect(shadowSection).toContain("EEE (10/12) → WATCH");
    expect(shadowSection).toContain("FFF (9/12) → WATCH");
    expect(shadowSection).toContain("CCC (8/12) → WATCH");
    expect(shadowSection).toContain("GGG (7/12) → WATCH");
    expect(shadowSection).not.toContain("AAA (6/12) → WATCH");
    expect(shadowSection).not.toContain("DDD (5/12) → WATCH");
    expect(shadowSection).not.toContain("HHH (4/12) → WATCH");
  });

  it("passes scanner-specific raw alert output to council", async () => {
    const council = vi.fn(async () => ({ verdicts: [] }));

    await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_BUY : DIP_BUY),
      council,
    });

    expect(council).toHaveBeenNthCalledWith(1, CANSLIM_BUY);
    expect(council).toHaveBeenNthCalledWith(2, DIP_BUY);
  });
});
