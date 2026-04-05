import { describe, expect, it } from "vitest";

import {
  buildDailyRecommendation,
  buildWeeklyDoseCalls,
  detectCardioInterference,
  detectCutRateRisk,
  recommendationConfidence,
} from "../../tools/fitness/training-engine.ts";

describe("fitness training engine", () => {
  it("degrades confidence when quality flags and low nutrition confidence exist", () => {
    const confidence = recommendationConfidence({
      readinessBand: "yellow",
      readinessConfidence: 0.82,
      sleepPerformance: 79,
      whoopStrain: 10,
      proteinTargetG: 130,
      proteinG: 90,
      nutritionConfidence: "low",
      qualityFlags: {
        stale_provider_data: true,
        unmapped_tonal_movements: 2,
      },
    });

    expect(confidence).toBeLessThan(0.82);
  });

  it("returns recover, zone2, controlled, and push in the expected situations", () => {
    expect(buildDailyRecommendation({
      readinessBand: "red",
      readinessConfidence: 0.8,
      sleepPerformance: 85,
      whoopStrain: 8,
      proteinTargetG: 130,
      proteinG: 130,
      nutritionConfidence: "high",
    }).mode).toBe("recover");

    expect(buildDailyRecommendation({
      readinessBand: "unknown",
      readinessConfidence: 0.35,
      sleepPerformance: null,
      whoopStrain: null,
      proteinTargetG: null,
      proteinG: null,
      nutritionConfidence: "low",
    }).mode).toBe("zone2_technique");

    expect(buildDailyRecommendation({
      readinessBand: "yellow",
      readinessConfidence: 0.84,
      sleepPerformance: 82,
      whoopStrain: 9,
      proteinTargetG: 130,
      proteinG: 120,
      nutritionConfidence: "medium",
    }).mode).toBe("controlled_train");

    expect(buildDailyRecommendation({
      readinessBand: "green",
      readinessConfidence: 0.92,
      sleepPerformance: 90,
      whoopStrain: 8,
      proteinTargetG: 130,
      proteinG: 132,
      nutritionConfidence: "high",
    }).mode).toBe("push");
  });

  it("classifies weekly underdose and overdose by muscle target", () => {
    const calls = buildWeeklyDoseCalls([
      { state_date: "2026-04-01", muscle_group: "chest", hard_sets: 3 } as any,
      { state_date: "2026-04-02", muscle_group: "back", hard_sets: 12 } as any,
      { state_date: "2026-04-03", muscle_group: "back", hard_sets: 10 } as any,
    ]);

    expect(calls.find((call) => call.muscle_group === "chest")?.status).toBe("underdosed");
    expect(calls.find((call) => call.muscle_group === "back")?.status).toBe("overdosed");
  });

  it("flags cut-rate and cardio interference risk when the weekly state supports it", () => {
    const cutRateRisk = detectCutRateRisk([
      {
        state_date: "2026-04-01",
        generated_at: "2026-04-01T12:00:00Z",
        readiness_score: 62,
        readiness_band: "yellow",
        readiness_confidence: 0.8,
        sleep_hours: 7.2,
        sleep_performance: 82,
        hrv: 100,
        rhr: 50,
        whoop_strain: 12,
        whoop_workouts: 1,
        step_count: 9000,
        step_source: "cycle",
        tonal_sessions: 1,
        tonal_volume: 12000,
        cardio_minutes: 10,
        cardio_summary: {},
        body_weight_kg: null,
        phase_mode: "aggressive_cut",
        target_weight_delta_pct_week: -0.9,
        protein_g: 120,
        protein_target_g: 130,
        calories_kcal: 2200,
        carbs_g: 180,
        fat_g: 70,
        hydration_liters: 2.5,
        nutrition_confidence: "high",
        recommendation_mode: "controlled_train",
        recommendation_confidence: 0.8,
        quality_flags: {},
        source_refs: {},
        raw: {},
      },
    ]);
    expect(cutRateRisk).toBe("watch");

    const cardioRisk = detectCardioInterference(
      [{
        state_date: "2026-04-01",
        generated_at: "2026-04-01T12:00:00Z",
        readiness_score: 62,
        readiness_band: "yellow",
        readiness_confidence: 0.8,
        sleep_hours: 7.2,
        sleep_performance: 82,
        hrv: 100,
        rhr: 50,
        whoop_strain: 12,
        whoop_workouts: 1,
        step_count: 9000,
        step_source: "cycle",
        tonal_sessions: 1,
        tonal_volume: 12000,
        cardio_minutes: 60,
        cardio_summary: {},
        body_weight_kg: null,
        phase_mode: "maintenance",
        target_weight_delta_pct_week: 0,
        protein_g: 120,
        protein_target_g: 130,
        calories_kcal: 2200,
        carbs_g: 180,
        fat_g: 70,
        hydration_liters: 2.5,
        nutrition_confidence: "high",
        recommendation_mode: "controlled_train",
        recommendation_confidence: 0.8,
        quality_flags: {},
        source_refs: {},
        raw: {},
      }],
      [
        { state_date: "2026-04-01", muscle_group: "quads", hard_sets: 8 } as any,
        { state_date: "2026-04-01", muscle_group: "hamstrings", hard_sets: 5 } as any,
        { state_date: "2026-04-01", muscle_group: "glutes", hard_sets: 6 } as any,
      ],
    );
    expect(cardioRisk).toBe("watch");
  });
});
