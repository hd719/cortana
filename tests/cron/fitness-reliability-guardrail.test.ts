import { describe, expect, it } from "vitest";

import {
  buildReliabilityGuardrailErrorCodes,
  evaluateMorningReliabilityGuardrail,
} from "../../tools/fitness/reliability-guardrail.ts";

describe("fitness reliability guardrail", () => {
  it("stays clear when core morning signals are healthy and complete", () => {
    const result = evaluateMorningReliabilityGuardrail({
      hasRecovery: true,
      hasSleep: true,
      recoveryFreshnessHours: 6,
      sleepFreshnessHours: 7,
      readinessBand: "green",
      sleepPerformance: 88,
      tonalHealthy: true,
      appleHealthStatus: "healthy",
      proteinTargetG: 130,
      proteinActualG: 128,
    });

    expect(result.status).toBe("ok");
    expect(result.modeCap).toBe("push");
    expect(result.blocksPush).toBe(false);
    expect(buildReliabilityGuardrailErrorCodes(result)).toEqual([]);
  });

  it("warns and caps intensity when WHOOP freshness is degraded", () => {
    const result = evaluateMorningReliabilityGuardrail({
      hasRecovery: true,
      hasSleep: true,
      recoveryFreshnessHours: 19,
      sleepFreshnessHours: 12,
      readinessBand: "green",
      sleepPerformance: 85,
      tonalHealthy: true,
      appleHealthStatus: "healthy",
      proteinTargetG: 130,
      proteinActualG: 125,
    });

    expect(result.status).toBe("warn");
    expect(result.modeCap).toBe("controlled_train");
    expect(result.confidenceCap).toBe(0.72);
    expect(result.reasons.map((reason) => reason.code)).toContain("whoop_recovery_stale");
    expect(buildReliabilityGuardrailErrorCodes(result)).toContain("whoop_recovery_stale");
  });

  it("blocks and falls back harder when the morning is effectively blind", () => {
    const result = evaluateMorningReliabilityGuardrail({
      hasRecovery: false,
      hasSleep: false,
      recoveryFreshnessHours: null,
      sleepFreshnessHours: null,
      readinessBand: "unknown",
      sleepPerformance: null,
      tonalHealthy: false,
      appleHealthStatus: "healthy",
      proteinTargetG: 130,
      proteinActualG: null,
    });

    expect(result.status).toBe("block");
    expect(result.modeCap).toBe("recover");
    expect(result.blocksPush).toBe(true);
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["whoop_recovery_missing", "whoop_sleep_missing", "tonal_unhealthy", "readiness_blind_spot", "nutrition_incomplete"]),
    );
  });

  it("keeps Apple Health concerns as confidence-only guidance", () => {
    const result = evaluateMorningReliabilityGuardrail({
      hasRecovery: true,
      hasSleep: true,
      recoveryFreshnessHours: 5,
      sleepFreshnessHours: 6,
      readinessBand: "green",
      sleepPerformance: 90,
      tonalHealthy: true,
      appleHealthStatus: "unconfigured",
      proteinTargetG: 130,
      proteinActualG: 130,
    });

    expect(result.status).toBe("ok");
    expect(result.modeCap).toBe("push");
    expect(result.confidenceCap).toBe(0.86);
    expect(result.reasons).toEqual([
      expect.objectContaining({
        code: "apple_health_unconfigured",
        impact: "confidence",
      }),
    ]);
  });
});
