import { describe, expect, it } from "vitest";
import { buildCouncilSessionArgs, parseSignals, shouldDeliberate } from "../../tools/council/trading-council";

describe("trading-council parsing", () => {
  it("parses BUY signals from CANSLIM output", () => {
    const sample = `📈 Trading Advisor - CANSLIM Scan
Summary: 2 candidates | BUY 1 | WATCH 1 | NO_BUY 0

• NVDA (9/12) → BUY
  Entry $910.50 | Stop $872.00
• MSFT (7/12) → WATCH
  Watch setup`;

    const signals = parseSignals(sample);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      ticker: "NVDA",
      action: "BUY",
      source: "CANSLIM",
      entryPrice: 910.5,
      stopLoss: 872,
    });
  });

  it("parses BUY signals from Dip Buyer output", () => {
    const sample = `📉 Trading Advisor - Dip Buyer Scan
Summary: 1 candidates | BUY 1 | WATCH 0 | NO_BUY 0

• TSLA (8/12) → BUY | 🐦 Contrarian ✅
  Entry $202.10 | Stop $190.00`;

    const signals = parseSignals(sample);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ticker: "TSLA",
      action: "BUY",
      source: "DipBuyer",
      entryPrice: 202.1,
      stopLoss: 190,
    });
  });

  it("NO_BUY/WATCH signals skip deliberation", () => {
    const sample = `📈 Trading Advisor - CANSLIM Scan
• AAPL (6/12) → WATCH
  Watch setup
• INTC (4/12) → NO_BUY
  Weak trend`;

    const signals = parseSignals(sample);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => !shouldDeliberate(s))).toBe(true);
  });

  it("builds session args with expected parameters", () => {
    const signal = {
      ticker: "NVDA",
      score: 9,
      action: "BUY",
      reason: "Entry $910.50 | Stop $872.00",
      entryPrice: 910.5,
      stopLoss: 872,
      source: "CANSLIM",
    } as const;

    const args = buildCouncilSessionArgs(signal);
    expect(args).toContain("--title");
    expect(args).toContain("BUY signal: NVDA via CANSLIM");
    expect(args).toContain("--participants");
    expect(args).toContain("risk-analyst,momentum-analyst,fundamentals-analyst");
    expect(args).toContain("--expires");
    expect(args).toContain("5");
  });
});
