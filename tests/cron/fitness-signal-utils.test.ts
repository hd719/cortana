import { describe, expect, it } from "vitest";
import {
  buildReadinessSignal,
  computeTrend,
  extractDailyStepCount,
  extractTonalSetActivities,
  overreachFlags,
  summarizeWhoopWeekly,
  summarizeTonalWeekly,
  tonalLoadBucket,
  tonalRepBucket,
} from "../../tools/fitness/signal-utils.ts";

describe("fitness signal utils", () => {
  it("classifies red readiness when recovery is low with heavy strain", () => {
    const readiness = buildReadinessSignal({
      recoveryTrend: computeTrend([39, 58, 63, 62]),
      hrvTrend: computeTrend([72, 95, 98]),
      rhrTrend: computeTrend([56, 50, 49]),
      sleepPerformance: 69,
      freshnessHours: 4,
      totalStrainToday: 16.2,
      yesterdayStrain: 14.8,
    });

    expect(readiness.band).toBe("red");
    expect(readiness.riskFlags).toContain("low_recovery");
    expect(readiness.hardTruth.toLowerCase()).toContain("pushing intensity");
  });

  it("returns unknown readiness when recovery signal is missing", () => {
    const readiness = buildReadinessSignal({
      recoveryTrend: computeTrend([null, null, null]),
      hrvTrend: computeTrend([null, null]),
      rhrTrend: computeTrend([null, null]),
      sleepPerformance: null,
      freshnessHours: null,
      totalStrainToday: 0,
      yesterdayStrain: 0,
    });

    expect(readiness.band).toBe("unknown");
    expect(readiness.confidence).toBeLessThan(0.5);
  });

  it("detects overreach scenarios with balanced thresholds", () => {
    const flags = overreachFlags({
      recoveryScore: 50,
      totalStrainToday: 16,
      yesterdayStrain: 15,
    });
    expect(flags).toContain("high_strain_with_non_green_recovery");
    expect(flags).toContain("back_to_back_heavy_strain");
  });

  it("summarizes weekly whoop and tonal metrics", () => {
    const whoopPayload = {
      recovery: [
        { created_at: "2026-03-18T09:00:00Z", score: { recovery_score: 58, hrv_rmssd_milli: 112, resting_heart_rate: 49 } },
        { created_at: "2026-03-17T09:00:00Z", score: { recovery_score: 69, hrv_rmssd_milli: 118, resting_heart_rate: 48 } },
      ],
      sleep: [
        {
          created_at: "2026-03-18T09:00:00Z",
          score: {
            sleep_performance_percentage: 80,
            sleep_efficiency_percentage: 86,
            stage_summary: {
              total_light_sleep_time_milli: 14000000,
              total_rem_sleep_time_milli: 3000000,
              total_slow_wave_sleep_time_milli: 6000000,
            },
          },
        },
      ],
      workouts: [
        { start: "2026-03-18T12:00:00Z", sport_name: "run", score: { strain: 8.2 } },
        { start: "2026-03-17T12:00:00Z", sport_name: "lift", score: { strain: 6.5 } },
      ],
    };
    const tonalPayload = {
      workouts: [
        { id: "a", beginTime: "2026-03-18T10:00:00Z", duration: 1800, stats: { totalVolume: 10000 } },
        { id: "b", beginTime: "2026-03-17T10:00:00Z", duration: 2100, stats: { totalVolume: 12000 } },
      ],
    };

    const whoopWeekly = summarizeWhoopWeekly(whoopPayload, "2026-03-18");
    const tonalWeekly = summarizeTonalWeekly(tonalPayload);

    expect(whoopWeekly.daysWithRecovery).toBe(2);
    expect(whoopWeekly.workouts).toBe(2);
    expect(tonalWeekly.workouts).toBe(2);
    expect(tonalWeekly.totalVolume).toBe(22000);
  });

  it("extracts daily steps from cycle first, then falls back to workouts sum", () => {
    const cyclePayload = {
      cycles: [
        {
          start: "2026-03-18T01:00:00-04:00",
          updated_at: "2026-03-18T21:00:00-04:00",
          score: { steps: 12456 },
        },
      ],
      workouts: [
        { start: "2026-03-18T12:00:00-04:00", score: { steps: 2200 } },
      ],
    };
    const cycleSteps = extractDailyStepCount(cyclePayload, "2026-03-18");
    expect(cycleSteps.stepCount).toBe(12456);
    expect(cycleSteps.source).toBe("cycle");

    const workoutPayload = {
      workouts: [
        { start: "2026-03-18T08:00:00-04:00", score: { steps: 3200 } },
        { start: "2026-03-18T18:00:00-04:00", score: { steps: 4100 } },
      ],
    };
    const workoutSteps = extractDailyStepCount(workoutPayload, "2026-03-18");
    expect(workoutSteps.stepCount).toBe(7300);
    expect(workoutSteps.source).toBe("workouts_sum");
  });

  it("extracts tonal set activities with deterministic mapping and buckets", () => {
    const activities = extractTonalSetActivities({
      workouts: [
        {
          id: "tonal-1",
          beginTime: "2026-03-18T10:00:00Z",
          workoutSetActivity: [
            {
              setId: "set-1",
              movementTitle: "Bench Press",
              repCount: 8,
              avgWeight: 55,
              volume: 440,
            },
            {
              setId: "set-2",
              movementTitle: "Unknown cable sorcery",
              repCount: 15,
              avgWeight: 12,
            },
          ],
        },
      ],
    });

    expect(activities).toHaveLength(2);
    expect(activities[0]?.muscleGroup).toBe("chest");
    expect(activities[0]?.loadBucket).toBe("heavy");
    expect(activities[0]?.repBucket).toBe("low");
    expect(activities[1]?.mapped).toBe(false);
    expect(activities[1]?.unmappedReason).toContain("No Tonal movement mapping matched");
    expect(tonalLoadBucket(12)).toBe("light");
    expect(tonalRepBucket(15)).toBe("high");
  });
});
