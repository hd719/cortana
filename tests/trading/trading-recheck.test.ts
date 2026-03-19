import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  applyTrackedSymbolExclusions,
  evaluateRecheckChanges,
  extractTrackedSymbols,
  formatRecheckAlert,
  loadState,
  loadRecheckExcludedSymbols,
  pickEligibleBaseRun,
  type RecheckChange,
} from "../../tools/trading/trading-recheck";

function candidate(
  file: string,
  {
    status = "success",
    completedAt,
    withStdout = true,
  }: {
    status?: "success" | "failed";
    completedAt: string;
    withStdout?: boolean;
  },
) {
  return {
    file,
    summary: {
      runId: path.basename(path.dirname(file)),
      status,
      completedAt,
      artifacts: {
        directory: path.dirname(file),
        summary: file,
        log: path.join(path.dirname(file), "run.log"),
        stdout: withStdout ? path.join(path.dirname(file), "stdout.txt") : undefined,
      },
    },
  };
}

describe("trading re-check base run selection", () => {
  it("returns null when the latest completed run failed", () => {
    const picked = pickEligibleBaseRun(
      [
        candidate("/tmp/older/summary.json", { completedAt: "2026-03-19T14:30:00.000Z" }),
        candidate("/tmp/newer/summary.json", { status: "failed", completedAt: "2026-03-19T16:30:00.000Z" }),
      ],
      Date.parse("2026-03-19T17:00:00.000Z"),
      4 * 60 * 60 * 1000,
    );

    expect(picked).toBeNull();
  });

  it("returns null when the latest successful run is stale", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-recheck-"));
    const runDir = path.join(root, "runs", "20260319-143000");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "stdout.txt"), "report");

    const picked = pickEligibleBaseRun(
      [
        candidate(path.join(runDir, "summary.json"), {
          completedAt: "2026-03-19T14:30:00.000Z",
        }),
      ],
      Date.parse("2026-03-19T20:45:00.000Z"),
      4 * 60 * 60 * 1000,
    );

    expect(picked).toBeNull();
  });
});

describe("trading re-check signal extraction", () => {
  it("extracts current BUY/WATCH names from persisted pipeline output", () => {
    const tracked = extractTrackedSymbols(`
Decision: BUY
CANSLIM: scanned 120 | evaluated 3 | threshold-passed 2 | BUY 1 | WATCH 1 | NO_BUY 1
• AAPL (9/12) → BUY | • MSFT (8/12) → WATCH | • SHOP (5/12) → NO_BUY
Dip Buyer: scanned 120 | evaluated 2 | threshold-passed 1 | BUY 0 | WATCH 1 | NO_BUY 1
• ROKU (7/12) → WATCH | • COIN (4/12) → NO_BUY
`);

    expect(tracked.map((item) => item.ticker)).toEqual(["AAPL", "MSFT", "ROKU"]);
  });

  it("applies explicit exclusions from env and file-backed symbol lists", () => {
    const root = mkdtempSync(path.join(process.cwd(), "tmp-recheck-exclude-"));
    const file = path.join(root, "exclude.txt");
    writeFileSync(
      file,
      `
# Ignore stale names from manual overrides
MSFT
ROKU, NVAX
`,
      "utf8",
    );
    const tracked = extractTrackedSymbols(`
Decision: BUY
CANSLIM: scanned 120 | evaluated 2 | threshold-passed 2 | BUY 1 | WATCH 1 | NO_BUY 0
• AAPL (9/12) → BUY | • MSFT (8/12) → WATCH
Dip Buyer: scanned 120 | evaluated 2 | threshold-passed 1 | BUY 0 | WATCH 1 | NO_BUY 1
• ROKU (7/12) → WATCH | • SHOP (4/12) → NO_BUY
`);
    const excluded = loadRecheckExcludedSymbols("PLTR, aapl", file);
    const filtered = applyTrackedSymbolExclusions(tracked, excluded);

    expect([...excluded].sort()).toEqual(["AAPL", "MSFT", "NVAX", "PLTR", "ROKU"]);
    expect(filtered).toEqual([]);
  });

  it("returns no tracked symbols when the report has no BUY or WATCH names", () => {
    const tracked = extractTrackedSymbols(`
Decision: NO_TRADE
CANSLIM: scanned 120 | evaluated 1 | threshold-passed 0 | BUY 0 | WATCH 0 | NO_BUY 1
• SHOP (5/12) → NO_BUY
`);

    expect(tracked).toEqual([]);
  });
});

describe("trading re-check change detection", () => {
  it("baselines first-seen symbols without emitting an alert", () => {
    const evaluation = evaluateRecheckChanges(
      loadState("/tmp/does-not-exist"),
      [
        { symbol: "AAPL", verdict: "needs confirmation", reason: "watch", base_action: "WATCH", score: 8, confidence: 67 },
      ],
      Date.parse("2026-03-19T15:00:00.000Z"),
      4 * 60 * 60 * 1000,
    );

    expect(evaluation.changes).toEqual([]);
    expect(evaluation.nextState.symbols.AAPL.verdict).toBe("needs confirmation");
  });

  it("emits an actionable upgrade when the verdict improves", () => {
    const evaluation = evaluateRecheckChanges(
      {
        schemaVersion: 1,
        updatedAt: "2026-03-19T15:00:00.000Z",
        symbols: {
          AAPL: {
            verdict: "needs confirmation",
            lastSeenAt: "2026-03-19T15:00:00.000Z",
            lastAlertedAt: null,
            lastAlertSignature: null,
          },
        },
      },
      [
        { symbol: "AAPL", verdict: "actionable", reason: "breakout confirmed", base_action: "BUY", score: 9, confidence: 79 },
      ],
      Date.parse("2026-03-19T16:00:00.000Z"),
      4 * 60 * 60 * 1000,
    );

    expect(evaluation.changes).toHaveLength(1);
    expect(evaluation.changes[0]).toMatchObject({
      symbol: "AAPL",
      previousVerdict: "needs confirmation",
      verdict: "actionable",
      direction: "upgrade",
    });
  });

  it("suppresses a repeated transition inside cooldown", () => {
    const evaluation = evaluateRecheckChanges(
      {
        schemaVersion: 1,
        updatedAt: "2026-03-19T15:00:00.000Z",
        symbols: {
          AAPL: {
            verdict: "needs confirmation",
            lastSeenAt: "2026-03-19T15:00:00.000Z",
            lastAlertedAt: "2026-03-19T15:30:00.000Z",
            lastAlertSignature: "AAPL:needs confirmation->actionable",
          },
        },
      },
      [
        { symbol: "AAPL", verdict: "actionable", reason: "breakout confirmed", base_action: "BUY", score: 9, confidence: 79 },
      ],
      Date.parse("2026-03-19T16:00:00.000Z"),
      4 * 60 * 60 * 1000,
    );

    expect(evaluation.changes).toEqual([]);
  });
});

describe("trading re-check alert formatting", () => {
  it("renders a compact operator summary", () => {
    const changes: RecheckChange[] = [
      {
        symbol: "AAPL",
        previousVerdict: "needs confirmation",
        verdict: "actionable",
        direction: "upgrade",
        reason: "breakout confirmed",
        baseAction: "BUY",
        score: 9,
        confidence: 79,
      },
      {
        symbol: "MSFT",
        previousVerdict: "actionable",
        verdict: "avoid for now",
        direction: "downgrade",
        reason: "setup failed",
        baseAction: "NO_BUY",
        score: 6,
        confidence: 45,
      },
    ];

    const text = formatRecheckAlert(
      "20260319-143000",
      [
        { ticker: "AAPL", sections: ["CANSLIM"], actions: ["WATCH"] },
        { ticker: "MSFT", sections: ["CANSLIM"], actions: ["BUY"] },
      ],
      changes,
      6,
    );

    expect(text).toContain("📈 Trading Re-check");
    expect(text).toContain("Base run: 20260319-143000");
    expect(text).toContain("Upgrades: AAPL needs confirmation -> actionable");
    expect(text).toContain("Downgrades: MSFT actionable -> avoid for now");
  });
});
