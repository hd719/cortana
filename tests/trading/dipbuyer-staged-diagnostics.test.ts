import { describe, expect, it } from "vitest";
import {
  runStage1Runner,
  runStage2Parser,
  runStage4Reporter,
  type Stage3Result,
} from "../../tools/trading/dipbuyer-staged-diagnostics";

describe("dipbuyer staged diagnostics", () => {
  it("marks stage1 as timeout when command exceeds hard wall timeout", async () => {
    const result = await runStage1Runner(
      {
        timeoutMs: 20,
        maxChars: 200,
      },
      {
        execute: async () => await new Promise(() => undefined),
      }
    );

    expect(result.status).toBe("timeout");
    expect(result.exitCode).toBe(124);
    expect(result.commandExitCode).toBe(124);
  });

  it("truncates oversized stdout/stderr and preserves byte counters", async () => {
    const stdout = "A".repeat(40);
    const stderr = "B".repeat(18);

    const result = await runStage1Runner(
      {
        timeoutMs: 100,
        maxChars: 12,
      },
      {
        execute: async () => ({
          exitCode: 0,
          stdout,
          stderr,
          timedOut: false,
        }),
      }
    );

    expect(result.status).toBe("ok");
    expect(result.io.stdout.value.length).toBe(12);
    expect(result.io.stdout.truncated).toBe(true);
    expect(result.io.stdout.bytes).toBe(Buffer.byteLength(stdout, "utf8"));
    expect(result.io.stderr.value.length).toBe(12);
    expect(result.io.stderr.truncated).toBe(true);
    expect(result.io.stderr.bytes).toBe(Buffer.byteLength(stderr, "utf8"));
  });

  it("builds compact stage2 parser schema from stage1 output", async () => {
    const raw = `📉 Trading Advisor - Dip Buyer Scan
Market: correction | Position Sizing: 50%
Status: Pullback with mixed breadth.
Macro Gate: OPEN | VIX 23 | PCR 1.07 | HY 450 bps (fallback_default_450)
HY Note: FRED HY spread unavailable after retries; using neutral 450 bps fallback.
Dip Profile: correction | buy>=7 | watch>=6 | max_pos=5%
Summary: scanned 120 | evaluated 2 | threshold-passed 2 | BUY 0 | WATCH 1 | NO_BUY 1
Blockers: Credit veto active (1)
• TSLA (8/12) → WATCH`;

    const stage1 = await runStage1Runner(
      {
        timeoutMs: 100,
        maxChars: 1000,
      },
      {
        execute: async () => ({
          exitCode: 0,
          stdout: raw,
          stderr: "",
          timedOut: false,
        }),
      }
    );

    const stage2 = await runStage2Parser(stage1, { timeoutMs: 100, maxChars: 300 });

    expect(stage2.schemaVersion).toBe("1.0");
    expect(stage2.parsed.summary).toEqual({
      scanned: 120,
      evaluated: 2,
      thresholdPassed: 2,
      buy: 0,
      watch: 1,
      noBuy: 1,
    });
    expect(stage2.parsed.marketRegime).toBe("correction");
    expect(stage2.parsed.macroGateLine).toContain("Macro Gate: OPEN");
    expect(stage2.status).toBe("degraded");
    expect(stage2.degradedReasons).toContain("external_fetch_fallback_detected");
    expect((stage2 as Record<string, unknown>).raw).toBeUndefined();
  });

  it("emits fixed reporter template with at most 8 evidence lines", async () => {
    const stage3: Stage3Result = {
      stage: "stage3_verifier",
      schemaVersion: "1.0",
      status: "degraded",
      exitCode: 2,
      durationMs: 10,
      fromStage2Status: "degraded",
      unified: {
        status: "ok",
        report: {
          value: "Unified report sample",
          bytes: 21,
          truncated: false,
          maxChars: 2000,
        },
      },
      comparisons: [
        { field: "dip_summary_buy", expected: "1", actual: "0", match: false },
        { field: "dip_summary_watch", expected: "1", actual: "1", match: true },
      ],
      mismatchCount: 1,
      degradedReasons: [
        "external_fetch_fallback_detected",
        "verification_mismatch_count_1",
        "extra_1",
        "extra_2",
        "extra_3",
        "extra_4",
        "extra_5",
        "extra_6",
      ],
      circuitBreaker: {
        integrated: true,
        status: "ok",
        recommendedProvider: "codex",
        reason: "tier1_available",
      },
    };

    const result = await runStage4Reporter(stage3, { timeoutMs: 100 });
    const lines = result.reportTemplate.split(/\r?\n/);
    const evidenceLines = lines.filter((line) => line.startsWith("- "));

    expect(lines[0]).toBe("VERDICT: DEGRADED");
    expect(lines[1]).toBe("EVIDENCE:");
    expect(evidenceLines.length).toBeLessThanOrEqual(8);
    expect(lines.at(-1)?.startsWith("NEXT ACTION:")).toBe(true);
  });
});
