import { describe, expect, it } from "vitest";

import { buildFatigueWindowSignal } from "../../tools/fitness/fatigue-engine.ts";
import { buildPlateauSignal, buildProgressionMomentum } from "../../tools/fitness/progression-engine.ts";

describe("fitness progression engine", () => {
  const makeAthleteRow = (overrides: Record<string, unknown>) =>
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

  const makeMuscleRow = (overrides: Record<string, unknown>) =>
    ({
      state_date: "2026-04-01",
      muscle_group: "chest",
      direct_sets: 4,
      indirect_sets: 2,
      hard_sets: 6,
      sessions: 1,
      load_bucket_summary: {},
      rep_bucket_summary: {},
      rir_estimate_avg: 2.5,
      source_confidence: 0.9,
      notes: {},
      ...overrides,
    }) as any;

  it("builds positive momentum when Tonal output and recovery both improve", () => {
    const athleteRows = [
      ...Array.from({ length: 7 }, (_, index) =>
        makeAthleteRow({
          state_date: `2026-03-${25 + index}`,
          readiness_score: 68,
          sleep_performance: 80,
          sleep_hours: 7.6,
          tonal_volume: 10000,
          whoop_strain: 9,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeAthleteRow({
          state_date: `2026-04-0${index + 1}`,
          readiness_score: 76,
          sleep_performance: 86,
          sleep_hours: 8,
          tonal_volume: 13200,
          whoop_strain: 10,
        }),
      ),
    ];
    const muscleRows = [
      ...Array.from({ length: 7 }, (_, index) =>
        makeMuscleRow({
          state_date: `2026-03-${25 + index}`,
          hard_sets: 34,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeMuscleRow({
          state_date: `2026-04-0${index + 1}`,
          hard_sets: 42,
        }),
      ),
    ];

    const momentum = buildProgressionMomentum({
      athleteStateRows: athleteRows,
      muscleVolumeRows: muscleRows,
      fatigueWindow: buildFatigueWindowSignal(athleteRows, { lookbackDays: 7 }),
    });

    expect(momentum.momentum).toBeGreaterThan(0);
    expect(["positive", "accelerating"]).toContain(momentum.direction);
    expect(momentum.evidence.tonal_volume_delta_pct).toBeGreaterThan(0);
  });

  it("flags plateau when output stalls and fatigue rises", () => {
    const athleteRows = [
      ...Array.from({ length: 7 }, (_, index) =>
        makeAthleteRow({
          state_date: `2026-03-${25 + index}`,
          readiness_score: 74,
          sleep_performance: 84,
          sleep_hours: 7.8,
          tonal_volume: 12200,
          whoop_strain: 9,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeAthleteRow({
          state_date: `2026-04-0${index + 1}`,
          readiness_score: 60,
          sleep_performance: 74,
          sleep_hours: 6.1,
          tonal_volume: 12300,
          whoop_strain: 14,
        }),
      ),
    ];
    const muscleRows = [
      ...Array.from({ length: 7 }, (_, index) =>
        makeMuscleRow({
          state_date: `2026-03-${25 + index}`,
          hard_sets: 40,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        makeMuscleRow({
          state_date: `2026-04-0${index + 1}`,
          hard_sets: 40,
        }),
      ),
    ];

    const fatigueWindow = buildFatigueWindowSignal(athleteRows, { lookbackDays: 7 });
    const plateau = buildPlateauSignal({
      athleteStateRows: athleteRows,
      muscleVolumeRows: muscleRows,
      fatigueWindow,
    });

    expect(plateau.plateau).toBe(true);
    expect(plateau.recommendation).toBe("deload");
    expect(plateau.rationale).toContain("stalled");
  });
});
