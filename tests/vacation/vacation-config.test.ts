import { describe, expect, it } from "vitest";
import { loadVacationOpsConfig, parseVacationOpsConfig } from "../../tools/vacation/vacation-config.ts";

describe("vacation ops config", () => {
  it("parses the tracked vacation config", () => {
    const config = loadVacationOpsConfig();
    expect(config.summaryTimes.morning).toBe("08:00");
    expect(config.summaryTimes.evening).toBe("20:00");
    expect(config.readinessFreshnessHours).toBe(6);
    expect(config.pausedJobIds).toContain("af9e1570-3ba2-4d10-a807-91cdfc2df18b");
    expect(config.systems.gateway_service.tier).toBe(0);
    expect(config.systems.browser_cdp.tier).toBe(1);
  });

  it("rejects configs missing the stable auto-update job id", () => {
    expect(() =>
      parseVacationOpsConfig({
        version: 1,
        timezone: "America/New_York",
        summaryTimes: { morning: "08:00", evening: "20:00" },
        readinessFreshnessHours: 6,
        authorizationFreshnessHours: 6,
        pausedJobIds: [],
        remediationLadder: ["retry"],
        guard: { fragileCronMatchers: [], quarantineAfterConsecutiveErrors: 1 },
        tier2Thresholds: {
          market_trading: { warnAfterMinutesMarketHours: 30, warnBeforeNextOpenMinutes: 60, warnAfterConsecutiveFailures: 2 },
          fitness_news: { warnAfterConsecutiveFailures: 2, warnAfterStaleHours: 24 },
          background_intel: { warnAfterConsecutiveFailures: 2, warnAfterStaleHours: 12 },
        },
        systems: {},
      }),
    ).toThrow(/Daily Auto-Update/);
  });
});
