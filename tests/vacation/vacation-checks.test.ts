import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadVacationOpsConfig } from "../../tools/vacation/vacation-config.ts";
import { runSystemCheck } from "../../tools/vacation/vacation-checks.ts";

const config = loadVacationOpsConfig();

function writeRuntimeCron(jobName: string, lastRunAt: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-checks-"));
  const runtimeCronFile = path.join(tempDir, "jobs.json");
  fs.writeFileSync(runtimeCronFile, JSON.stringify({
    jobs: [
      {
        id: "job-1",
        name: jobName,
        enabled: true,
        state: {
          lastRunAtMs: Date.parse(lastRunAt),
          lastStatus: "ok",
          lastRunStatus: "ok",
          lastDeliveryStatus: "ok",
          consecutiveErrors: 0,
        },
      },
    ],
  }), "utf8");
  return runtimeCronFile;
}

describe("vacation market checks", () => {
  it("computes premarket next-open timing from the current session", () => {
    const runtimeCronFile = writeRuntimeCron("📈 Stock Market Brief (daily)", "2026-03-31T12:00:00.000Z");
    const result = runSystemCheck(config, {
      runtimeCronFile,
      now: () => new Date("2026-03-31T13:00:00.000Z"),
    }, "market_scans");

    expect(result.detail.marketHours).toBe(false);
    expect(result.detail.marketPhase).toBe("PREMARKET");
    expect(result.detail.minutesBeforeNextOpen).toBe(30);
  });

  it("marks regular-hours market checks as market-hours instead of pre-open", () => {
    const runtimeCronFile = writeRuntimeCron("📈 Stock Market Brief (daily)", "2026-03-31T14:30:00.000Z");
    const result = runSystemCheck(config, {
      runtimeCronFile,
      now: () => new Date("2026-03-31T15:00:00.000Z"),
    }, "market_scans");

    expect(result.detail.marketHours).toBe(true);
    expect(result.detail.marketPhase).toBe("OPEN");
    expect(result.detail.minutesBeforeNextOpen).toBe(0);
  });
});
