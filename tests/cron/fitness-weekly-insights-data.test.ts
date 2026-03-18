import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWeeklyProteinAssumption, weeklyPaths } from "../../tools/fitness/weekly-insights-data.ts";

describe("fitness weekly insights persistence paths", () => {
  it("returns sandbox-safe weekly path and repo mirror path", () => {
    const paths = weeklyPaths("2026-W12", "cron-fitness");

    expect(paths.sandboxFilePath).toContain(path.join(".openclaw", "workspaces", "cron-fitness"));
    expect(paths.sandboxFilePath).toContain(path.join("memory", "fitness", "weekly", "2026-W12.md"));
    expect(paths.repoFilePath).toBe("/Users/hd/Developer/cortana/memory/fitness/weekly/2026-W12.md");
  });

  it("infers conservative weekly protein assumption when logs are missing", () => {
    const assumption = buildWeeklyProteinAssumption({
      currentDaysLogged: 0,
      previousDaysLogged: 0,
      currentAvgProtein: null,
    });

    expect(assumption.status).toBe("assume_likely_below_target_unverified");
    expect(assumption.confidence).toBe("low");
  });
});
