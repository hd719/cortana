import { describe, expect, it } from "vitest";
import { buildWhoopSummary, tonalTodayWorkouts, tonalWorkoutsFromPayload } from "../../tools/fitness/evening-recap-data.ts";

describe("fitness evening recap tonal payload handling", () => {
  it("extracts workouts when tonal.workouts is an object keyed by workout id", () => {
    const payload = {
      workouts: {
        "f24d719e-e4dc-45d0-b757-5338b3c15deb": {
          beginTime: "2026-03-10T05:53:57-04:00",
          duration: 1800,
          totalVolume: 12345,
          stats: null,
          detail: { title: "Upper Body Strength" },
        },
      },
    };

    const workouts = tonalWorkoutsFromPayload(payload);
    expect(workouts).toHaveLength(1);
    expect(workouts[0].id).toBe("f24d719e-e4dc-45d0-b757-5338b3c15deb");

    const todays = tonalTodayWorkouts(payload, "2026-03-10");
    expect(todays).toHaveLength(1);
    expect(todays[0]).toMatchObject({
      id: "f24d719e-e4dc-45d0-b757-5338b3c15deb",
      time: "2026-03-10T05:53:57-04:00",
      volume: 12345,
      duration_minutes: 30,
      title: "Upper Body Strength",
    });
  });

  it("still supports array-style tonal workouts without regression", () => {
    const payload = {
      workouts: [
        {
          id: "abc",
          beginTime: "2026-03-10T07:00:00-04:00",
          duration: 900,
          stats: { totalVolume: 5000 },
        },
      ],
    };

    const todays = tonalTodayWorkouts(payload, "2026-03-10");
    expect(todays).toHaveLength(1);
    expect(todays[0].id).toBe("abc");
    expect(todays[0].volume).toBe(5000);
    expect(todays[0].duration_minutes).toBe(15);
  });

  it("summarizes whoop strain and workout context for today", () => {
    const whoop = {
      recovery: [{ created_at: "2026-03-10T09:00:00Z", score: { recovery_score: 63 } }],
      sleep: [{ created_at: "2026-03-10T09:00:00Z", score: { sleep_performance_percentage: 78 } }],
      workouts: [
        { start: "2026-03-10T12:00:00Z", sport_name: "run", score: { strain: 7.2 } },
        { start: "2026-03-10T14:00:00Z", sport_name: "lift", score: { strain: 5.8 } },
      ],
    };

    const summary = buildWhoopSummary(whoop, "2026-03-10");
    expect(summary.total_strain_today).toBe(13);
    expect(summary.cycle_strain_today).toBeNull();
    expect(summary.workouts_strain_sum_today).toBe(13);
    expect(summary.strain_source).toBe("workouts_sum");
    expect(summary.whoop_workouts_today).toBe(2);
    expect(summary.top_sports_today.sort()).toEqual(["lift", "run"]);
  });

  it("prefers cycle strain as canonical daily strain when available", () => {
    const whoop = {
      cycles: [
        {
          start: "2026-03-10T05:00:00Z",
          updated_at: "2026-03-10T13:00:00Z",
          score: { strain: 13.9 },
        },
      ],
      workouts: [
        { start: "2026-03-10T12:00:00Z", sport_name: "run", score: { strain: 7.2 } },
        { start: "2026-03-10T14:00:00Z", sport_name: "lift", score: { strain: 5.8 } },
      ],
    };

    const summary = buildWhoopSummary(whoop, "2026-03-10");
    expect(summary.total_strain_today).toBe(13.9);
    expect(summary.cycle_strain_today).toBe(13.9);
    expect(summary.workouts_strain_sum_today).toBe(13);
    expect(summary.strain_source).toBe("cycle");
  });
});
