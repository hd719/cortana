import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWeeklyProteinAssumption,
  buildWeeklyWindowMetricsFromState,
  weeklyPaths,
} from "../../tools/fitness/weekly-insights-data.ts";

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

  it("builds weekly metrics from canonical athlete-state rows", () => {
    const metrics = buildWeeklyWindowMetricsFromState({
      startYmd: "2026-04-01",
      endYmd: "2026-04-07",
      athleteStateRows: [
        {
          state_date: "2026-04-01",
          generated_at: "2026-04-01T12:00:00Z",
          readiness_score: 68,
          readiness_band: "green",
          readiness_confidence: 0.9,
          sleep_hours: 7.8,
          sleep_performance: 84,
          hrv: 105,
          rhr: 49,
          whoop_strain: 12.4,
          whoop_workouts: 1,
          step_count: 10000,
          step_source: "cycle",
          tonal_sessions: 1,
          tonal_volume: 12000,
          cardio_minutes: 20,
          cardio_summary: {},
          body_weight_kg: 84,
          body_weight_source: "apple_health",
          body_weight_confidence: 0.92,
          active_energy_kcal: 650,
          resting_energy_kcal: 1800,
          walking_running_distance_km: 7.2,
          body_fat_pct: 14.1,
          lean_mass_kg: 63.5,
          health_source_confidence: 0.88,
          health_context: {
            goal_mode: { status: "on_pace" },
          },
          phase_mode: "lean_gain",
          target_weight_delta_pct_week: 0.15,
          protein_g: 152,
          protein_target_g: 150,
          calories_kcal: 2400,
          carbs_g: 220,
          fat_g: 70,
          hydration_liters: 2.8,
          nutrition_confidence: "high",
          recommendation_mode: "push",
          recommendation_confidence: 0.91,
          quality_flags: {},
          source_refs: {},
          raw: {
            meal_rollup: {
              mealsLogged: 3,
            },
          },
        },
        {
          state_date: "2026-04-02",
          generated_at: "2026-04-02T12:00:00Z",
          readiness_score: 61,
          readiness_band: "yellow",
          readiness_confidence: 0.8,
          sleep_hours: 7.1,
          sleep_performance: 79,
          hrv: 101,
          rhr: 50,
          whoop_strain: 10.2,
          whoop_workouts: 1,
          step_count: 9200,
          step_source: "cycle",
          tonal_sessions: 0,
          tonal_volume: 0,
          cardio_minutes: 0,
          cardio_summary: {},
          body_weight_kg: 84.2,
          body_weight_source: "apple_health",
          body_weight_confidence: 0.91,
          active_energy_kcal: 620,
          resting_energy_kcal: 1785,
          walking_running_distance_km: 6.1,
          body_fat_pct: 14.2,
          lean_mass_kg: 63.4,
          health_source_confidence: 0.87,
          health_context: {},
          phase_mode: "lean_gain",
          target_weight_delta_pct_week: 0.15,
          protein_g: 148,
          protein_target_g: 150,
          calories_kcal: 2280,
          carbs_g: 205,
          fat_g: 68,
          hydration_liters: 2.4,
          nutrition_confidence: "medium",
          recommendation_mode: "controlled_train",
          recommendation_confidence: 0.84,
          quality_flags: {},
          source_refs: {},
          raw: {
            meal_rollup: {
              mealsLogged: 2,
            },
          },
        },
      ] as any,
    });

    expect(metrics.days_with_recovery).toBe(2);
    expect(metrics.avg_recovery).toBe(64.5);
    expect(metrics.tonal_sessions).toBe(1);
    expect(metrics.protein_days_logged).toBe(2);
    expect(metrics.protein_days_on_target).toBe(1);
    expect(metrics.body_weight_days_logged).toBe(2);
    expect(metrics.avg_body_weight_kg).toBe(84.1);
    expect(metrics.avg_active_energy_kcal).toBe(635);
  });
});
