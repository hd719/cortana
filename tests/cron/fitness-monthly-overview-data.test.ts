import { describe, expect, it } from "vitest";
import {
  bodyWeightCoverageReason,
  buildMonthlyWindowSummaryFromState,
  completedMonthlyWindows,
  monthlyWindows,
  stepCoverageReason,
  trajectoryReason,
} from "../../tools/fitness/monthly-overview-data.ts";

describe("fitness monthly overview windows", () => {
  it("returns current and previous month windows from anchor date", () => {
    const windows = monthlyWindows("2026-03-18");
    expect(windows.current.start).toBe("2026-03-01");
    expect(windows.current.end).toBe("2026-03-31");
    expect(windows.previous.start).toBe("2026-02-01");
    expect(windows.previous.end).toBe("2026-02-28");
  });

  it("handles year boundary correctly", () => {
    const windows = monthlyWindows("2026-01-11");
    expect(windows.current.start).toBe("2026-01-01");
    expect(windows.previous.start).toBe("2025-12-01");
    expect(windows.previous.end).toBe("2025-12-31");
  });

  it("returns the most recently completed month window for first-of-month runs", () => {
    const windows = completedMonthlyWindows("2026-04-01");
    expect(windows.current.start).toBe("2026-03-01");
    expect(windows.current.end).toBe("2026-03-31");
    expect(windows.previous.start).toBe("2026-02-01");
    expect(windows.previous.end).toBe("2026-02-28");
  });

  it("explains unknown trajectory when prior month coverage is missing", () => {
    const current = {
      days_with_data: 14,
    } as any;
    const previous = {
      days_with_data: 0,
    } as any;

    expect(trajectoryReason(current, previous)).toBe("no prior completed-month baseline with sufficient coverage");
  });

  it("explains missing step coverage even when other fitness snapshots exist", () => {
    const current = {
      days_with_steps: 0,
      days_with_data: 14,
    } as any;

    expect(stepCoverageReason(current)).toContain("Athlete-state rows exist");
  });

  it("explains missing body-weight coverage even when other fitness snapshots exist", () => {
    const current = {
      days_with_body_weight: 0,
      days_with_data: 14,
    } as any;

    expect(bodyWeightCoverageReason(current)).toContain("trusted daily body-weight field");
  });

  it("builds monthly summaries from canonical athlete-state rows", () => {
    const summary = buildMonthlyWindowSummaryFromState([
      {
        state_date: "2026-03-01",
        readiness_score: 70,
        sleep_hours: 7.7,
        sleep_performance: 85,
        hrv: 102,
        rhr: 49,
        whoop_strain: 11,
        body_weight_kg: 84.2,
        active_energy_kcal: 640,
        resting_energy_kcal: 1810,
        walking_running_distance_km: 7.4,
        body_fat_pct: 14.1,
        lean_mass_kg: 63.6,
        tonal_sessions: 1,
        tonal_volume: 12000,
        protein_g: 150,
        protein_target_g: 150,
        hydration_liters: 2.5,
        step_count: 9800,
        recommendation_mode: "push",
      },
      {
        state_date: "2026-03-02",
        readiness_score: 62,
        sleep_hours: 7.1,
        sleep_performance: 79,
        hrv: 98,
        rhr: 50,
        whoop_strain: 10,
        body_weight_kg: 84,
        active_energy_kcal: 610,
        resting_energy_kcal: 1780,
        walking_running_distance_km: 6.8,
        body_fat_pct: 14.2,
        lean_mass_kg: 63.4,
        tonal_sessions: 0,
        tonal_volume: 0,
        protein_g: 142,
        protein_target_g: 150,
        hydration_liters: 2.1,
        step_count: 8600,
        recommendation_mode: "controlled_train",
      },
    ] as any, "2026-03-01", "2026-03-31");

    expect(summary.days_with_data).toBe(2);
    expect(summary.avg_readiness).toBe(66);
    expect(summary.days_with_body_weight).toBe(2);
    expect(summary.avg_body_weight_kg).toBe(84.1);
    expect(summary.total_tonal_sessions).toBe(1);
    expect(summary.protein_days_on_target).toBe(1);
    expect(summary.days_with_recommendation).toBe(2);
  });
});
