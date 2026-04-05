import { describe, expect, it } from "vitest";

import { buildAthleteStateForDate, buildMuscleVolumeRowsForDate } from "../../tools/fitness/athlete-state-data.ts";
import type { MealEntry } from "../../tools/fitness/meal-log.ts";

describe("fitness athlete-state builder", () => {
  it("builds a deterministic daily athlete-state row and muscle-volume rows", () => {
    const mealEntries: MealEntry[] = [
      {
        timestamp: "2026-04-05T12:00:00Z",
        date: "2026-04-05",
        proteinG: 140,
        calories: 2250,
        carbsG: 210,
        fatG: 70,
        hydrationLiters: 2.6,
        note: "post workout",
        sourceFile: "spartan-1.jsonl",
      },
    ];
    const whoopPayload = {
      quality: {
        duplicate_workout_ids_removed: 2,
        repeated_next_token_detected: false,
      },
      body_measurement: {
        weight_kg: 84.2,
      },
      recovery: [
        {
          created_at: "2026-04-05T09:00:00Z",
          score: {
            recovery_score: 72,
            hrv_rmssd_milli: 108,
            resting_heart_rate: 48,
          },
        },
        {
          created_at: "2026-04-04T09:00:00Z",
          score: {
            recovery_score: 66,
            hrv_rmssd_milli: 102,
            resting_heart_rate: 49,
          },
        },
      ],
      sleep: [
        {
          created_at: "2026-04-05T09:00:00Z",
          score: {
            sleep_performance_percentage: 84,
            sleep_efficiency_percentage: 88,
            stage_summary: {
              total_light_sleep_time_milli: 16000000,
              total_rem_sleep_time_milli: 3500000,
              total_slow_wave_sleep_time_milli: 5000000,
            },
          },
        },
      ],
      workouts: [
        {
          id: "lift-1",
          start: "2026-04-05T11:00:00Z",
          end: "2026-04-05T12:00:00Z",
          sport_name: "strength_training",
          score: { strain: 9.2 },
        },
        {
          id: "run-1",
          start: "2026-04-05T15:00:00Z",
          end: "2026-04-05T15:30:00Z",
          sport_name: "run",
          score: { strain: 5.1 },
        },
      ],
      cycles: [
        {
          start: "2026-04-05T08:00:00-04:00",
          updated_at: "2026-04-05T21:00:00-04:00",
          score: { steps: 10120 },
        },
      ],
    };
    const tonalPayload = {
      workouts: {
        "tonal-1": {
          beginTime: "2026-04-05T10:00:00Z",
          duration: 1800,
          totalVolume: 12450,
          detail: { title: "Upper Push" },
          workoutSetActivity: [
            {
              setId: "set-1",
              movementTitle: "Bench Press",
              repCount: 8,
              avgWeight: 55,
              volume: 440,
              repsInReserve: 2,
            },
            {
              setId: "set-2",
              movementTitle: "Shoulder Press",
              repCount: 12,
              avgWeight: 17.5,
              volume: 210,
            },
            {
              setId: "set-3",
              movementTitle: "Mystery Pull",
              repCount: 10,
              avgWeight: 42,
              volume: 420,
            },
          ],
        },
      },
    };

    const result = buildAthleteStateForDate({
      stateDate: "2026-04-05",
      generatedAt: "2026-04-05T12:30:00Z",
      whoopPayload,
      tonalPayload,
      mealEntries,
      coachNutrition: {
        date_local: "2026-04-05",
        protein_target_g: 160,
        protein_actual_g: 145,
        hydration_status: "on_track",
        calories_actual_kcal: 2280,
        carbs_g: 220,
        fats_g: 68,
        hydration_liters: 2.9,
        meals_logged: 3,
        confidence: "high",
        phase_mode: "gentle_cut",
        notes: "manual row",
      },
    });

    expect(result.athleteState).toMatchObject({
      stateDate: "2026-04-05",
      readinessScore: 72,
      readinessBand: "green",
      whoopWorkouts: 2,
      stepCount: 10120,
      tonalSessions: 1,
      tonalVolume: 12450,
      cardioMinutes: 30,
      bodyWeightKg: 84.2,
      phaseMode: "gentle_cut",
      proteinG: 145,
      proteinTargetG: 160,
      hydrationLiters: 2.9,
      nutritionConfidence: "high",
    });
    expect(result.athleteState.qualityFlags?.duplicate_whoop_workouts_removed).toBe(2);
    expect(result.athleteState.qualityFlags?.unmapped_tonal_movements).toBe(1);
    expect(result.muscleVolumeRows.find((row) => row.muscleGroup === "chest")?.hardSets).toBe(1);
    expect(result.muscleVolumeRows.find((row) => row.muscleGroup === "shoulders")?.hardSets).toBe(1);
  });

  it("surfaces missing phase/bodyweight and returns no fake muscle rows when all movements are unmapped", () => {
    const rows = buildMuscleVolumeRowsForDate({
      stateDate: "2026-04-05",
      tonalPayload: {
        workouts: [
          {
            id: "tonal-2",
            beginTime: "2026-04-05T12:00:00Z",
            workoutSetActivity: [
              {
                setId: "mystery-1",
                movementTitle: "Unknown contraption",
                repCount: 15,
                avgWeight: 20,
              },
            ],
          },
        ],
      },
    });

    expect(rows.rows).toHaveLength(0);
    expect(rows.unmappedCount).toBe(1);

    const result = buildAthleteStateForDate({
      stateDate: "2026-04-05",
      whoopPayload: { recovery: [], sleep: [], workouts: [] },
      tonalPayload: { workouts: [] },
      mealEntries: [],
    });

    expect(result.athleteState.phaseMode).toBe("unknown");
    expect(result.athleteState.bodyWeightKg).toBeNull();
    expect(result.athleteState.proteinTargetG).toBeNull();
    expect(result.athleteState.qualityFlags?.missing_phase_mode).toBe(true);
    expect(result.athleteState.qualityFlags?.missing_body_weight).toBe(true);
  });
});
