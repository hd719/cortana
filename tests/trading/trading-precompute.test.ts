import { describe, expect, it } from "vitest";
import {
  buildTradingPrecomputeSummary,
  formatTradingPrecomputeSummary,
  summarizeCalibrationArtifact,
  summarizeNightlyDiscoveryReport,
} from "../../tools/trading/trading-precompute";

describe("trading precompute", () => {
  it("summarizes nightly discovery artifacts", () => {
    const summary = summarizeNightlyDiscoveryReport({
      feature_snapshot: {
        symbol_count: 120,
        generated_at: "2026-03-19T12:00:00+00:00",
        source: "ranked_universe_selector.refresh_cache",
      },
      liquidity_overlay: {
        symbol_count: 118,
      },
    });

    expect(summary.featureSnapshot.symbolCount).toBe(120);
    expect(summary.featureSnapshot.generatedAt).toBe("2026-03-19T12:00:00+00:00");
    expect(summary.liquiditySymbolCount).toBe(118);
  });

  it("summarizes calibration freshness", () => {
    const summary = summarizeCalibrationArtifact({
      generated_at: "2026-03-19T12:05:00+00:00",
      freshness: { is_stale: false, reason: "fresh" },
      summary: { settled_candidates: 24 },
    });

    expect(summary.status).toBe("fresh");
    expect(summary.settledCandidates).toBe(24);
  });

  it("builds and formats a combined precompute summary from command results", () => {
    const payloads = [
      {
        feature_snapshot: {
          symbol_count: 120,
          generated_at: "2026-03-19T12:00:00+00:00",
          source: "ranked_universe_selector.refresh_cache",
        },
        liquidity_overlay: { symbol_count: 117 },
      },
      [{ symbol: "AAA" }, { symbol: "BBB" }],
      {
        generated_at: "2026-03-19T12:05:00+00:00",
        freshness: { is_stale: true, reason: "no_settled_records" },
        summary: { settled_candidates: 0 },
      },
    ];
    const summary = buildTradingPrecomputeSummary({
      runJson: () => payloads.shift(),
    });

    expect(summary.featureSnapshot.symbolCount).toBe(120);
    expect(summary.settledCount).toBe(2);
    expect(summary.calibration.status).toBe("stale");
    expect(formatTradingPrecomputeSummary(summary)).toContain("Trading precompute complete");
    expect(formatTradingPrecomputeSummary(summary)).toContain("Calibration: stale | settled 0");
  });
});
