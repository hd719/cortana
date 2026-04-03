import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildArtifact,
  MARKET_BRIEF_ARTIFACT_FAMILY,
  MARKET_BRIEF_SCHEMA_VERSION,
  parseSnapshotPayload,
  writeArtifact,
} from "../../tools/market-intel/stock-market-brief-collect.ts";

function buildSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    artifact_family: MARKET_BRIEF_ARTIFACT_FAMILY,
    schema_version: MARKET_BRIEF_SCHEMA_VERSION,
    producer: "backtester.market_brief_snapshot",
    generated_at: "2026-03-31T12:00:00Z",
    known_at: "2026-03-31T12:00:00Z",
    status: "ok",
    degraded_status: "healthy",
    outcome_class: "market_gate_blocked",
    regime: {
      label: "correction",
      display: "CORRECTION",
      position_sizing_pct: 0,
      distribution_days: 7,
      regime_score: -7,
      notes: "Stay defensive.",
      status: "ok",
      data_source: "schwab",
    },
    posture: { action: "NO_BUY", reason: "Stay defensive." },
    macro: { state: "watch", summary_line: "Polymarket mixed." },
    tape: { summary_line: "SPY weak.", risk_tone: "defensive", primary_source: "schwab", symbols: [] },
    focus: { symbols: ["MSFT", "META"] },
    ...overrides,
  };
}

describe("stock market brief collector", () => {
  it("parses a healthy market-gated snapshot payload", () => {
    const raw = JSON.stringify(buildSnapshot());

    const payload = parseSnapshotPayload(raw);
    expect(payload.artifact_family).toBe("market_brief");
    expect(payload.degraded_status).toBe("healthy");
    expect(payload.outcome_class).toBe("market_gate_blocked");
    expect(payload.regime.display).toBe("CORRECTION");
    expect(payload.posture.action).toBe("NO_BUY");
  });

  it("parses degraded-safe and degraded-risky snapshot payloads", () => {
    const degradedSafe = parseSnapshotPayload(
      JSON.stringify(
        buildSnapshot({
          status: "degraded",
          degraded_status: "degraded_safe",
          outcome_class: "degraded_safe",
          tape: { summary_line: "Fallback tape.", risk_tone: "defensive", primary_source: "cache", symbols: [] },
        }),
      ),
    );
    const degradedRisky = parseSnapshotPayload(
      JSON.stringify(
        buildSnapshot({
          status: "error",
          degraded_status: "degraded_risky",
          outcome_class: "degraded_risky",
          tape: { summary_line: "Tape unavailable.", risk_tone: "unknown", primary_source: "unavailable", symbols: [] },
          macro: { state: "unknown", summary_line: "Macro unavailable." },
        }),
      ),
    );

    expect(degradedSafe.degraded_status).toBe("degraded_safe");
    expect(degradedSafe.tape.primary_source).toBe("cache");
    expect(degradedRisky.degraded_status).toBe("degraded_risky");
    expect(degradedRisky.tape.primary_source).toBe("unavailable");
  });

  it("rejects payloads missing typed contract fields", () => {
    expect(() =>
      parseSnapshotPayload(
        JSON.stringify({
          generated_at: "2026-03-31T12:00:00Z",
          status: "ok",
          regime: {},
        }),
      ),
    ).toThrow("snapshot payload must be artifact_family=market_brief");
  });

  it("builds an artifact with session metadata", () => {
    const artifact = buildArtifact(
      buildSnapshot(),
      new Date("2026-03-31T11:55:00Z"),
    );

    expect(artifact.session.phase).toBe("PREMARKET");
    expect(artifact.snapshot.focus.symbols).toEqual(["MSFT", "META"]);
  });

  it("writes the artifact to disk", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-brief-"));
    const artifactPath = path.join(tempDir, "brief.json");
    const artifact = buildArtifact(buildSnapshot(), new Date("2026-03-31T11:55:00Z"));

    writeArtifact(artifact, artifactPath);
    const saved = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
      session: { phase: string };
      snapshot: { artifact_family: string; degraded_status: string };
    };
    expect(saved.session.phase).toBe("PREMARKET");
    expect(saved.snapshot.artifact_family).toBe("market_brief");
    expect(saved.snapshot.degraded_status).toBe("healthy");
  });
});
