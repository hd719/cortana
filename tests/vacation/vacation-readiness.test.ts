import { describe, expect, it } from "vitest";
import { deriveReadinessOutcome, shouldAttemptRemediation } from "../../tools/vacation/readiness-engine.ts";
import { loadVacationOpsConfig } from "../../tools/vacation/vacation-config.ts";

const config = loadVacationOpsConfig();

describe("vacation readiness", () => {
  it("returns NO-GO when a Tier 0 system is red", () => {
    const outcome = deriveReadinessOutcome([
      { system_key: "gateway_service", tier: 0, status: "red", observed_at: "2026-04-11T12:00:00.000Z", detail: {} },
      { system_key: "gog_headless_auth", tier: 1, status: "green", observed_at: "2026-04-11T12:00:00.000Z", detail: {} },
    ], config);
    expect(outcome.outcome).toBe("no_go");
  });

  it("does not keep older degraded evidence once a newer healthy result exists", () => {
    const outcome = deriveReadinessOutcome([
      { system_key: "gog_headless_auth", tier: 1, status: "red", observed_at: "2026-04-11T10:00:00.000Z", detail: {} },
      { system_key: "gog_headless_auth", tier: 1, status: "green", observed_at: "2026-04-11T12:00:00.000Z", detail: {} },
    ], config);
    expect(outcome.finalResults[0]?.status).toBe("green");
  });

  it("fails when a required system is missing entirely", () => {
    const outcome = deriveReadinessOutcome([
      { system_key: "gateway_service", tier: 0, status: "green", observed_at: "2026-04-11T12:00:00.000Z", detail: {} },
    ], config);
    expect(outcome.outcome).toBe("fail");
    expect(outcome.missingRequiredSystemKeys).toContain("gog_headless_auth");
  });

  it("allows remediation for failed Tier 0 systems that declare bounded repair steps", () => {
    expect(shouldAttemptRemediation(config, {
      system_key: "runtime_integrity",
      tier: 0,
      status: "red",
      observed_at: "2026-04-11T12:00:00.000Z",
      detail: {},
    })).toBe(true);
  });

  it("does not attempt remediation for healthy systems or Tier 2 watch lanes", () => {
    expect(shouldAttemptRemediation(config, {
      system_key: "gateway_service",
      tier: 0,
      status: "green",
      observed_at: "2026-04-11T12:00:00.000Z",
      detail: {},
    })).toBe(false);

    expect(shouldAttemptRemediation(config, {
      system_key: "market_scans",
      tier: 2,
      status: "red",
      observed_at: "2026-04-11T12:00:00.000Z",
      detail: {},
    })).toBe(false);
  });
});
