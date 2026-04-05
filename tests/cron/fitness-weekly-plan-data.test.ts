import { describe, expect, it } from "vitest";

import { buildWeeklyPlan, isoWeekForDate } from "../../tools/fitness/weekly-plan-data.ts";

describe("fitness weekly plan data", () => {
  const makeAthleteRow = (overrides: Record<string, unknown>) =>
    ({
      state_date: "2026-04-05",
      generated_at: "2026-04-05T12:00:00Z",
      readiness_score: 74,
      readiness_band: "green",
      readiness_confidence: 0.9,
      sleep_hours: 7.8,
      sleep_performance: 85,
      hrv: 105,
      rhr: 49,
      whoop_strain: 10,
      whoop_workouts: 1,
      step_count: 9000,
      step_source: "apple_health",
      tonal_sessions: 1,
      tonal_volume: 12000,
      cardio_minutes: 20,
      cardio_summary: { by_sport_minutes: { walk: 20 }, by_mode_minutes: { walk: 20 } },
      body_weight_kg: 84,
      body_weight_source: "apple_health",
      body_weight_confidence: 0.92,
      active_energy_kcal: 650,
      resting_energy_kcal: 1800,
      walking_running_distance_km: 7,
      body_fat_pct: 14,
      lean_mass_kg: 63,
      health_source_confidence: 0.9,
      health_context: {},
      phase_mode: "lean_gain",
      target_weight_delta_pct_week: 0.15,
      fatigue_debt: 4,
      sleep_debt: 0.5,
      progression_momentum: 6,
      training_context: {},
      protein_g: 150,
      protein_target_g: 150,
      calories_kcal: 2400,
      carbs_g: 220,
      fat_g: 70,
      hydration_liters: 2.8,
      nutrition_confidence: "high",
      recommendation_mode: "push",
      recommendation_confidence: 0.9,
      quality_flags: {},
      source_refs: {},
      raw: {},
      ...overrides,
    }) as any;

  const makeMuscleRow = (overrides: Record<string, unknown>) =>
    ({
      state_date: "2026-04-05",
      muscle_group: "chest",
      direct_sets: 4,
      indirect_sets: 0,
      hard_sets: 4,
      sessions: 1,
      load_bucket_summary: {},
      rep_bucket_summary: {},
      rir_estimate_avg: 2,
      source_confidence: 0.9,
      weekly_rollup_sets: null,
      weekly_status: null,
      target_sets_min: null,
      target_sets_max: null,
      notes: {},
      ...overrides,
    }) as any;

  it("builds deterministic weekly training state and recommendation outputs", () => {
    const athleteRows = [
      makeAthleteRow({ state_date: "2026-03-30", tonal_volume: 11000 }),
      makeAthleteRow({ state_date: "2026-03-31", tonal_volume: 11200 }),
      makeAthleteRow({ state_date: "2026-04-01", tonal_volume: 11800 }),
      makeAthleteRow({ state_date: "2026-04-02", tonal_volume: 12000 }),
      makeAthleteRow({ state_date: "2026-04-03", tonal_volume: 12400 }),
      makeAthleteRow({ state_date: "2026-04-04", tonal_volume: 12600 }),
      makeAthleteRow({ state_date: "2026-04-05", tonal_volume: 12800 }),
    ];
    const muscleRows = [
      makeMuscleRow({ state_date: "2026-03-30", muscle_group: "chest", hard_sets: 4 }),
      makeMuscleRow({ state_date: "2026-04-01", muscle_group: "chest", hard_sets: 4 }),
      makeMuscleRow({ state_date: "2026-04-03", muscle_group: "back", hard_sets: 14 }),
      makeMuscleRow({ state_date: "2026-04-04", muscle_group: "back", hard_sets: 10 }),
    ];

    const result = buildWeeklyPlan({
      endDate: "2026-04-05",
      athleteStateRows: athleteRows,
      muscleVolumeRows: muscleRows,
    });

    expect(result.isoWeek).toBe(isoWeekForDate("2026-04-05"));
    expect(result.trainingState.phaseMode).toBe("lean_gain");
    expect(result.trainingState.athleteStateDays).toBe(7);
    expect(result.trainingState.underdosedMuscles).toHaveProperty("chest");
    expect(result.trainingState.overdosedMuscles).toHaveProperty("back");
    expect(result.recommendation.recommendationScope).toBe("weekly");
    expect(result.recommendation.outputs?.mode).toBeDefined();
  });

  it("prefers deload when fatigue debt is clearly elevated", () => {
    const athleteRows = Array.from({ length: 7 }, (_, index) =>
      makeAthleteRow({
        state_date: `2026-04-0${index + 1}`,
        readiness_score: 58,
        sleep_hours: 6,
        sleep_performance: 72,
        whoop_strain: 15,
        tonal_sessions: 2,
        tonal_volume: 16500,
        cardio_minutes: 45,
        cardio_summary: { by_sport_minutes: { run: 45 }, by_mode_minutes: { run: 45 } },
      }),
    );
    const muscleRows = Array.from({ length: 7 }, (_, index) =>
      makeMuscleRow({
        state_date: `2026-04-0${index + 1}`,
        muscle_group: index % 2 === 0 ? "quads" : "hamstrings",
        hard_sets: 10,
      }),
    );

    const result = buildWeeklyPlan({
      endDate: "2026-04-07",
      athleteStateRows: athleteRows,
      muscleVolumeRows: muscleRows,
    });

    expect(result.trainingState.recommendationSummary?.mode).toBe("deload");
    expect(result.trainingState.fatigueScore).toBeGreaterThan(24);
  });
});
