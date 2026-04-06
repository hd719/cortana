import { describe, expect, it } from "vitest";

import {
  buildDeloadTrigger,
  buildFatigueDailyContribution,
  buildRollingFatigueDebt,
  buildRollingSleepDebt,
} from "../../tools/fitness/fatigue-engine.ts";

describe("fitness fatigue engine", () => {
  const makeRow = (overrides: Record<string, unknown>) =>
    ({
      state_date: "2026-04-01",
      generated_at: "2026-04-01T12:00:00Z",
      readiness_score: 72,
      readiness_band: "yellow",
      readiness_confidence: 0.8,
      sleep_hours: 7.5,
      sleep_performance: 82,
      hrv: 100,
      rhr: 50,
      whoop_strain: 10,
      whoop_workouts: 1,
      step_count: 9000,
      step_source: "cycle",
      tonal_sessions: 1,
      tonal_volume: 12000,
      cardio_minutes: 20,
      cardio_summary: {},
      body_weight_kg: 84,
      body_weight_source: "apple_health",
      body_weight_confidence: 0.9,
      active_energy_kcal: 600,
      resting_energy_kcal: 1800,
      walking_running_distance_km: 6,
      body_fat_pct: 14,
      lean_mass_kg: 63,
      health_source_confidence: 0.9,
      health_context: {},
      phase_mode: "lean_gain",
      target_weight_delta_pct_week: 0.1,
      protein_g: 140,
      protein_target_g: 150,
      calories_kcal: 2300,
      carbs_g: 210,
      fat_g: 70,
      hydration_liters: 2.6,
      nutrition_confidence: "high",
      recommendation_mode: "controlled_train",
      recommendation_confidence: 0.8,
      quality_flags: {},
      source_refs: {},
      raw: {},
      ...overrides,
    }) as any;

  it("builds a larger fatigue debt when load is high and sleep is poor", () => {
    const lowLoad = buildFatigueDailyContribution(makeRow({
      state_date: "2026-04-01",
      whoop_strain: 7,
      sleep_hours: 8.2,
      sleep_performance: 90,
      tonal_volume: 8000,
      cardio_minutes: 10,
      readiness_score: 82,
    }));
    const highLoad = buildFatigueDailyContribution(makeRow({
      state_date: "2026-04-02",
      whoop_strain: 15,
      sleep_hours: 5.9,
      sleep_performance: 71,
      tonal_volume: 18000,
      tonal_sessions: 2,
      cardio_minutes: 60,
      readiness_score: 58,
    }));

    expect(highLoad.fatigue_debt).toBeGreaterThan(lowLoad.fatigue_debt);
    expect(highLoad.sleep_debt).toBeGreaterThan(lowLoad.sleep_debt);
  });

  it("accumulates rolling fatigue and sleep debt and triggers a deload on sustained strain", () => {
    const rows = [
      makeRow({
        state_date: "2026-04-01",
        whoop_strain: 14,
        sleep_hours: 6.1,
        sleep_performance: 74,
        tonal_volume: 16000,
        tonal_sessions: 2,
        cardio_minutes: 45,
        readiness_score: 59,
      }),
      makeRow({
        state_date: "2026-04-02",
        whoop_strain: 15,
        sleep_hours: 6.0,
        sleep_performance: 72,
        tonal_volume: 17000,
        tonal_sessions: 2,
        cardio_minutes: 50,
        readiness_score: 57,
      }),
      makeRow({
        state_date: "2026-04-03",
        whoop_strain: 16,
        sleep_hours: 5.8,
        sleep_performance: 70,
        tonal_volume: 17500,
        tonal_sessions: 2,
        cardio_minutes: 55,
        readiness_score: 55,
      }),
      makeRow({
        state_date: "2026-04-04",
        whoop_strain: 13,
        sleep_hours: 6.2,
        sleep_performance: 73,
        tonal_volume: 15000,
        tonal_sessions: 1,
        cardio_minutes: 30,
        readiness_score: 61,
      }),
    ];

    const rollingFatigue = buildRollingFatigueDebt(rows, { lookbackDays: 4 });
    const rollingSleep = buildRollingSleepDebt(rows, { lookbackDays: 4 });
    const deload = buildDeloadTrigger(rows, { lookbackDays: 4 });

    expect(rollingFatigue.fatigue_debt).toBeGreaterThan(40);
    expect(rollingSleep.sleep_debt).toBeGreaterThan(5);
    expect(deload.triggered).toBe(true);
    expect(deload.recommendation).toBe("deload");
    expect(deload.rationale).toContain("Deload");
  });
});
