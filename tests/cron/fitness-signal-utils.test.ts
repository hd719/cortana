import { describe, expect, it } from "vitest";
import {
  buildReadinessSignal,
  computeTrend,
  overreachFlags,
  summarizeWhoopWeekly,
  summarizeTonalWeekly,
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
});

