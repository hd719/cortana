import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildTodayMissionArtifact, todayMissionPaths } from "../../tools/fitness/today-mission-data.ts";

describe("fitness today mission artifact", () => {
  it("builds a controlled mission from moderate readiness and observed fueling", () => {
    const mission = buildTodayMissionArtifact({
      dateLocal: "2026-04-05",
      readinessScore: 58,
      sleepPerformance: 82,
      hrvLatest: 101,
      rhrLatest: 50,
      recoveryFreshnessHours: 4,
      sleepFreshnessHours: 6,
      whoopStrainToday: 12.4,
      tonalSessionsToday: 1,
      tonalVolumeToday: 13250,
      stepCountToday: 11800,
      mealsLoggedToday: 2,
      proteinActualGToday: 126,
      proteinStatusToday: "on_target",
      proteinTargetG: 130,
      hydrationStatusToday: "on_track",
      weeklyProteinDaysLogged: 5,
      weeklyProteinDaysOnTarget: 4,
      weeklyProteinDaysLoggedPrior: 4,
      weeklyProteinAvgDaily: 124,
    });

    expect(mission.schema).toBe("spartan.today_mission.v1");
    expect(mission.readiness.band).toBe("yellow");
    expect(mission.readiness.emoji).toBe("🟡");
    expect(mission.training.mode).toBe("controlled_train");
    expect(mission.nutrition.status).toBe("observed_from_logs");
    expect(mission.weekly_fueling.status).toBe("observed_from_logs");
    expect(mission.sleep_target.goal_hours).toBe(7.5);
    expect(mission.priorities[0]).toContain("controlled session");
    expect(mission.non_negotiables[0]).toContain("Protein target");
    expect(mission.confidence).toBe("high");
  });

  it("falls back to conservative guidance when recovery data is stale", () => {
    const mission = buildTodayMissionArtifact({
      dateLocal: "2026-04-05",
      readinessScore: null,
      sleepPerformance: 73,
      recoveryFreshnessHours: 24,
      sleepFreshnessHours: 5,
      whoopStrainToday: 18.5,
      tonalSessionsToday: 2,
      tonalVolumeToday: 18400,
      stepCountToday: 6200,
      mealsLoggedToday: 0,
      proteinActualGToday: null,
      proteinStatusToday: "unknown",
      weeklyProteinDaysLogged: 0,
      weeklyProteinDaysLoggedPrior: 0,
      weeklyProteinAvgDaily: null,
    });

    expect(mission.readiness.band).toBe("unknown");
    expect(mission.training.mode).toBe("zone2_mobility");
    expect(mission.nutrition.status).toBe("assume_likely_below_target_unverified");
    expect(mission.top_risk).toContain("stale recovery data");
    expect(mission.confidence).toBe("low");
    expect(mission.sleep_target.goal_hours).toBe(8.25);
  });

  it("returns stable sandbox and repo mission paths", () => {
    const paths = todayMissionPaths("2026-04-05", "cron-fitness");

    expect(paths.sandboxFilePath).toContain(path.join(".openclaw", "workspaces", "cron-fitness"));
    expect(paths.sandboxFilePath).toContain(path.join("memory", "fitness", "daily", "2026-04-05.json"));
    expect(paths.repoFilePath).toBe("/Users/hd/Developer/cortana/memory/fitness/daily/2026-04-05.json");
  });
});
