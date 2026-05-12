import { describe, expect, it } from "vitest";
import { deriveReadinessOutcome } from "../../tools/vacation/readiness-engine.ts";
import { loadVacationOpsConfig } from "../../tools/vacation/vacation-config.ts";

const config = loadVacationOpsConfig();
const configWithMarketDataTier2 = {
  ...config,
  systems: {
    ...config.systems,
    market_data_smoke: {
      tier: 2,
      required: false,
      tier2Class: "market_trading" as const,
      probe: "runtime_cron:market-data smoke",
      freshnessSource: "cron_run",
      remediation: ["rerun_smoke"],
    },
  },
};

const healthyRequired = Object.entries(config.systems)
  .filter(([, def]) => def.required)
  .map(([key, def]) => ({
    system_key: key,
    tier: def.tier,
    status: "green" as const,
    observed_at: "2026-04-11T12:00:00.000Z",
    detail: {},
  }));

describe("vacation thresholds", () => {
  it("warns when a market-data tier-2 failure crosses its configured threshold", () => {
    const outcome = deriveReadinessOutcome([
      ...healthyRequired,
      {
        system_key: "market_data_smoke",
        tier: 2,
        status: "yellow",
        observed_at: "2026-04-11T12:00:00.000Z",
        detail: {
          marketHours: true,
          staleMinutes: 45,
          consecutiveFailures: 2,
          minutesBeforeNextOpen: 120,
        },
      },
    ], configWithMarketDataTier2);
    expect(outcome.outcome).toBe("warn");
    expect(outcome.tier2WarnSystemKeys).toContain("market_data_smoke");
  });

  it("warns near the next market open even when outside market hours", () => {
    const outcome = deriveReadinessOutcome([
      ...healthyRequired,
      {
        system_key: "market_data_smoke",
        tier: 2,
        status: "yellow",
        observed_at: "2026-04-11T12:00:00.000Z",
        detail: {
          marketHours: false,
          staleMinutes: 5,
          consecutiveFailures: 0,
          minutesBeforeNextOpen: 25,
        },
      },
    ], configWithMarketDataTier2);
    expect(outcome.outcome).toBe("warn");
    expect(outcome.tier2WarnSystemKeys).toContain("market_data_smoke");
  });

  it("does not use next-open proximity as a warning trigger during market hours", () => {
    const outcome = deriveReadinessOutcome([
      ...healthyRequired,
      {
        system_key: "market_data_smoke",
        tier: 2,
        status: "yellow",
        observed_at: "2026-04-11T12:00:00.000Z",
        detail: {
          marketHours: true,
          staleMinutes: 5,
          consecutiveFailures: 0,
          minutesBeforeNextOpen: 0,
        },
      },
    ], configWithMarketDataTier2);
    expect(outcome.outcome).toBe("pass");
  });

  it("stays PASS when tier-2 degradation has not crossed its warning threshold", () => {
    const outcome = deriveReadinessOutcome([
      ...healthyRequired,
      {
        system_key: "secondary_dashboard_enrichments",
        tier: 2,
        status: "yellow",
        observed_at: "2026-04-11T12:00:00.000Z",
        detail: {
          staleHours: 1,
          consecutiveFailures: 1,
        },
      },
    ], config);
    expect(outcome.outcome).toBe("pass");
  });
});
