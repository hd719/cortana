import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTradingPipeline } from "../../tools/trading/trading-pipeline";

const CANSLIM_NO_BUY = `📈 Trading Advisor - CANSLIM Scan
Market: correction | Position Sizing: 0%
Status: 7 distribution days. Reduce exposure.
Summary: scanned 120 | evaluated 1 | threshold-passed 1 | BUY 0 | WATCH 1 | NO_BUY 0
Blockers: Below min-score filter (5<6) (2)
• AAPL (7/12) → WATCH
  Watch setup`;

const DIP_NO_BUY = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 50%
Status: Pullback with mixed breadth.
Macro Gate: OPEN | VIX 23 | PCR 1.07 | HY 450 bps (fallback_default_450) | Fear 39 | Fallback impact: neutral-credit assumption
HY Note: FRED HY spread unavailable after retries; using neutral 450 bps fallback (credit gate may be less sensitive).
Dip Profile: correction | buy>=7 | watch>=6 | max_pos=5%
Summary: scanned 120 | evaluated 1 | threshold-passed 1 | BUY 0 | WATCH 1 | NO_BUY 0
Blockers: Credit veto active (1)
Blocker samples: Credit veto active => TSLA
• TSLA (8/12) → WATCH
  Watch setup`;

const CANSLIM_BUY = `📈 Trading Advisor - CANSLIM Scan
Market: confirmed_uptrend | Position Sizing: 100%
Status: Trend healthy.
Summary: scanned 120 | evaluated 1 | threshold-passed 1 | BUY 1 | WATCH 0 | NO_BUY 0
• NVDA (9/12) → BUY
  Entry $900.00 | Stop $855.00`;

const DIP_BUY = `📉 Trading Advisor - Dip Buyer Scan
Market: uptrend_under_pressure | Position Sizing: 50%
Status: Selective risk only.
Macro Gate: OPEN | VIX 21 | PCR 0.96 | HY 421 bps (fred) | Fear 42
Dip Profile: under_pressure | buy>=7 | watch>=6 | max_pos=6%
Summary: scanned 120 | evaluated 1 | threshold-passed 1 | BUY 1 | WATCH 0 | NO_BUY 0
• TSLA (8/12) → BUY
  Entry $200.00 | Stop $186.00`;

const DIP_RAW_COMPACT = `Dip Buyer Scan
Market regime: correction
Qualified setups: 20 of 20 scanned | BUY 0 | WATCH 8
BUY names: none
Top leaders: GOOGL WATCH (9/12) 🐦 Neutral | NFLX WATCH (9/12) 🐦 Neutral | MSFT WATCH (9/12) 🐦 Neutral
Decision review: BUY 0 | WATCH 5 | NO_BUY 0
Tuning balance: clean BUY 0 | risky BUY proxy 0 | abstain 0 | veto 0 | higher-tq restraint proxy n/a
Leaders: GOOGL WATCH (9/12) 🐦 Neutral | NFLX WATCH (9/12) 🐦 Neutral | MSFT WATCH (9/12) 🐦 Neutral
Final action: DO NOT BUY — market regime veto (Regime score -7: 6 distribution days and -4.5% drawdown. Stay defensive)`;

beforeEach(() => {
  process.env.FRED_API_KEY = "test-dummy-key";
});

afterEach(() => {
  delete process.env.FRED_API_KEY;
  delete process.env.TRADING_SCAN_LIMIT;
  delete process.env.TRADING_SCAN_LIMIT_CANSLIM;
  delete process.env.TRADING_SCAN_LIMIT_DIP;
  delete process.env.TRADING_SCAN_CHUNK_SIZE;
  delete process.env.TRADING_SCAN_CHUNK_SIZE_CANSLIM;
  delete process.env.TRADING_SCAN_CHUNK_SIZE_DIP;
  delete process.env.TRADING_SCAN_CHUNK_PARALLELISM;
  delete process.env.TRADING_SCAN_CHUNK_PARALLELISM_CANSLIM;
  delete process.env.TRADING_SCAN_CHUNK_PARALLELISM_DIP;
  delete process.env.TRADING_DIP_CORRECTION_MAX_BUYS;
  delete process.env.TRADING_DIP_CORRECTION_MIN_BUY_SCORE;
});

describe("trading pipeline orchestration", () => {
  it("does not call council when no BUY signals are present", async () => {
    const council = vi.fn(async () => ({ verdicts: [] }));

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : DIP_NO_BUY),
      council,
    });

    expect(council).not.toHaveBeenCalled();
    expect(report).toContain("Summary: BUY 0 | WATCH 2 | NO_BUY 0");
    expect(report).toContain("Diagnostics: symbols scanned 240 | candidates evaluated 2");
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

  it("parses compact dip buyer output so wrapper counts do not collapse to zero", async () => {
    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : DIP_RAW_COMPACT),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("Diagnostics: symbols scanned 140 | candidates evaluated 21");
    expect(report).toContain("Dip Buyer: scanned 20 | evaluated 20 | threshold-passed 5 | emitted BUY 0 / WATCH 3 / NO_BUY 0");
  });

  it("preserves CANSLIM correction hard gate even if scanner emits BUY", async () => {
    const correctionCanslimBuy = `📈 Trading Advisor - CANSLIM Scan
Market: correction | Position Sizing: 0%
Status: risk-off
Summary: scanned 120 | evaluated 1 | threshold-passed 1 | BUY 1 | WATCH 0 | NO_BUY 0
• NVDA (9/12) → BUY
  Entry $900.00 | Stop $855.00`;

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? correctionCanslimBuy : DIP_NO_BUY),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("CANSLIM hard gate blocked 1 BUY signal(s) in correction");
    expect(report).toContain("NVDA (9/12) → NO_BUY");
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
Status: distribution pressure.
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
Status: selective risk only.
Macro Gate: OPEN | VIX 22 | PCR 1.01 | HY 460 bps (fred) | Fear 40
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

  it("includes explicit regime/gate and HY fallback diagnostics in the unified report", async () => {
    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : DIP_NO_BUY),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("Regime/Gates: correction=YES");
    expect(report).toContain("Macro Gate: OPEN | VIX 23 | PCR 1.07 | HY 450 bps (fallback_default_450)");
    expect(report).toContain("HY Note: FRED HY spread unavailable after retries");
    expect(report).toContain("Dip Profile: correction | buy>=7 | watch>=6 | max_pos=5%");
    expect(report).toContain("Blockers: Credit veto active (1)");
  });

  it("reports top blocker when a scanner emits zero BUY/WATCH signals", async () => {
    const canslimNoCandidates = `📈 Trading Advisor - CANSLIM Scan
Market: correction | Position Sizing: 0%
Status: 8 distribution days. Risk-off.
No CANSLIM candidates met the current scan threshold.`;

    const dipNoBuyOnly = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 25%
Status: Credit stressed.
Macro Gate: CLOSED | VIX 30 | PCR 1.20 | HY 701 bps (fred) | Fear 75
Summary: 1 candidates | BUY 0 | WATCH 0 | NO_BUY 1
• IWM (5/12) → NO_BUY | Credit veto active`;

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? canslimNoCandidates : dipNoBuyOnly),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("CANSLIM: scanned 120 | evaluated 0");
    expect(report).toContain("Top blocker: No symbols passed scanner threshold.");
    expect(report).toContain("Dip Buyer: scanned 120 | evaluated 1 | threshold-passed 1 | emitted BUY 0 / WATCH 0 / NO_BUY 1");
    expect(report).toContain("Top blocker: No reason provided. (1)");
  });

  it("supports scanner-specific env limits and legacy shared env override", async () => {
    const calls: Array<string[]> = [];
    process.env.TRADING_SCAN_LIMIT = "90";
    process.env.TRADING_SCAN_LIMIT_CANSLIM = "140";

    await runTradingPipeline({
      runCommand: (_cmd, args) => {
        calls.push(args);
        return args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : DIP_NO_BUY;
      },
      council: async () => ({ verdicts: [] }),
    });

    const canslimCall = calls.find((args) => args[0] === "canslim_alert.py") ?? [];
    const dipCall = calls.find((args) => args[0] === "dipbuyer_alert.py") ?? [];
    expect(canslimCall).toContain("140");
    expect(dipCall).toContain("90");
  });

  it("preserves merged chunk summaries so combined CANSLIM output is parsed correctly", async () => {
    process.env.TRADING_SCAN_LIMIT_CANSLIM = "4";
    process.env.TRADING_SCAN_CHUNK_SIZE_CANSLIM = "2";
    process.env.TRADING_SCAN_CHUNK_PARALLELISM_CANSLIM = "1";

    const canslimChunks = [
      `📈 Trading Advisor - CANSLIM Scan
Market: confirmed_uptrend | Position Sizing: 100%
Status: Trend healthy.
Summary: scanned 2 | evaluated 1 | threshold-passed 1 | BUY 0 | WATCH 1 | NO_BUY 0
• AAPL (7/12) → WATCH
  Watch setup`,
      `📈 Trading Advisor - CANSLIM Scan
Market: confirmed_uptrend | Position Sizing: 100%
Status: Trend healthy.
Summary: scanned 2 | evaluated 1 | threshold-passed 1 | BUY 0 | WATCH 1 | NO_BUY 0
• MSFT (8/12) → WATCH
  Watch setup`,
    ];

    const calls: Array<{ args: string[]; priorityFile?: string }> = [];
    const report = await runTradingPipeline({
      getUniverse: async (limit) => ["AAPL", "MSFT", "NVDA", "TSLA"].slice(0, limit),
      runCommand: (_cmd, args, options) => {
        calls.push({ args, priorityFile: options?.env?.TRADING_PRIORITY_FILE });
        if (args[0] === "canslim_alert.py") {
          return canslimChunks.shift() ?? CANSLIM_NO_BUY;
        }
        return DIP_NO_BUY;
      },
      council: async () => ({ verdicts: [] }),
    });

    expect(calls.filter((call) => call.args[0] === "canslim_alert.py")).toHaveLength(2);
    expect(calls.filter((call) => call.priorityFile).length).toBeGreaterThanOrEqual(2);
    expect(report).toContain("CANSLIM: scanned 4 | evaluated 2 | threshold-passed 2 | emitted BUY 0 / WATCH 2 / NO_BUY 0");
    expect(report).toContain("Summary: BUY 0 | WATCH 3 | NO_BUY 0");
  });

  it("enforces CANSLIM correction hard gate and skips council when blocked", async () => {
    const canslimCorrectionBuy = `📈 Trading Advisor - CANSLIM Scan
Market: correction | Position Sizing: 0%
Status: risk-off.
Summary: 1 candidates | BUY 1 | WATCH 0 | NO_BUY 0
• NVDA (10/12) → BUY
  Momentum setup`;

    const council = vi.fn(async () => ({ verdicts: [] }));

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? canslimCorrectionBuy : DIP_NO_BUY),
      council,
    });

    expect(council).not.toHaveBeenCalled();
    expect(report).toContain("CANSLIM correction hard gate (execution blocked)");
    expect(report).toContain("Guardrails: blocked/downgraded 1");
  });

  it("applies dip correction risk caps and reports blocker telemetry", async () => {
    process.env.TRADING_DIP_CORRECTION_MAX_BUYS = "1";
    process.env.TRADING_DIP_CORRECTION_MIN_BUY_SCORE = "8";

    const dipCorrectionBuys = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 25%
Status: choppy.
Macro Gate: OPEN | VIX 24 | PCR 1.08 | HY 455 bps (fred) | Fear 48
Summary: 3 candidates | BUY 3 | WATCH 0 | NO_BUY 0
• TSLA (10/12) → BUY
  Setup A
• AMD (9/12) → BUY
  Setup B
• IWM (7/12) → BUY
  Setup C`;

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : dipCorrectionBuys),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("Dip correction profile: max BUY=1, min BUY score=8/12.");
    expect(report).toContain("Dip correction caps downgraded 2 BUY signal(s) to WATCH.");
    expect(report).toContain("Blocker telemetry: guardrail blocks/downgrades 2");
    expect(report).toContain("Summary: BUY 1 | WATCH 3 | NO_BUY 0");
  });

  it("emits the full post-guard Dip Buyer watchlist instead of truncating at four names", async () => {
    process.env.TRADING_DIP_CORRECTION_MAX_BUYS = "1";
    process.env.TRADING_DIP_CORRECTION_MIN_BUY_SCORE = "8";

    const dipCorrectionManyBuys = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 25%
Status: choppy.
Macro Gate: OPEN | VIX 24 | PCR 1.08 | HY 455 bps (fred) | Fear 48
Summary: 8 candidates | BUY 8 | WATCH 0 | NO_BUY 0
• ARES (10/12) → BUY
  Setup A
• ALGN (7/12) → BUY
  Setup B
• ACN (7/12) → BUY
  Setup C
• AEP (8/12) → BUY
  Setup D
• ADSK (9/12) → BUY
  Setup E
• ANET (7/12) → BUY
  Setup F
• AMAT (7/12) → BUY
  Setup G
• APP (8/12) → BUY
  Setup H`;

    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_NO_BUY : dipCorrectionManyBuys),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("Dip Buyer: scanned 120 | evaluated 8 | threshold-passed 8 | emitted BUY 1 / WATCH 7 / NO_BUY 0");
    expect(report).toContain("• ALGN (7/12) → WATCH | Correction cap: BUY requires score >= 8/12");
    expect(report).toContain("• ACN (7/12) → WATCH | Correction cap: BUY requires score >= 8/12");
    expect(report).toContain("• AEP (8/12) → WATCH | Correction cap: max 1 BUY signal(s)");
    expect(report).toContain("• ADSK (9/12) → WATCH | Correction cap: max 1 BUY signal(s)");
    expect(report).toContain("• ANET (7/12) → WATCH | Correction cap: BUY requires score >= 8/12");
    expect(report).toContain("• AMAT (7/12) → WATCH | Correction cap: BUY requires score >= 8/12");
    expect(report).toContain("• APP (8/12) → WATCH | Correction cap: max 1 BUY signal(s)");
  });

  it("emits deterministic decision/confidence/risk fields", async () => {
    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? CANSLIM_BUY : DIP_NO_BUY),
      council: async () => ({ verdicts: [] }),
    });

    expect(report).toContain("Decision: BUY");
    expect(report).toContain("Confidence: 0.61 | Risk: HIGH");
  });

  it("fails closed with explicit no-trade reason when required scanner fields are missing", async () => {
    const badCanslim = `📈 Trading Advisor - CANSLIM Scan
Summary: 1 candidates | BUY 1 | WATCH 0 | NO_BUY 0
• NVDA (10/12) → BUY
  Momentum setup`;

    const council = vi.fn(async () => ({ verdicts: [] }));
    const report = await runTradingPipeline({
      runCommand: (_cmd, args) => (args[0] === "canslim_alert.py" ? badCanslim : DIP_NO_BUY),
      council,
    });

    expect(council).not.toHaveBeenCalled();
    expect(report).toContain("Decision: WATCH");
    expect(report).toContain("Fail-closed scans: CANSLIM");
    expect(report).toContain("Guardrails: Fail-closed: missing market regime in scanner output");
  });

});
