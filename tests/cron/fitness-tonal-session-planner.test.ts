import { describe, expect, it } from "vitest";

import { buildTonalProgramCatalog } from "../../tools/fitness/tonal-program-catalog.ts";
import { buildTonalSessionPlan } from "../../tools/fitness/tonal-session-planner.ts";

describe("fitness tonal session planner", () => {
  const catalog = buildTonalProgramCatalog({
    profile: { userId: "user-1" },
    workouts: {
      "activity-1": {
        id: "activity-1",
        beginTime: "2026-04-03T12:00:00Z",
        totalDuration: 1800,
        totalVolume: 12000,
        workoutId: "workout-upper-1",
        programId: "program-a",
        workoutType: "Linear",
        workoutSetActivity: [
          { id: "set-1", workoutActivityID: "activity-1", setId: "set-1", movementId: "8edc0211-4594-4e5e-8e1b-b05dfc1d67c7", repCount: 8, avgWeight: 50, totalVolume: 400 },
          { id: "set-2", workoutActivityID: "activity-1", setId: "set-2", movementId: "ec9edd5f-4745-45b7-b78b-b7368839ca38", repCount: 10, avgWeight: 45, totalVolume: 450 },
          { id: "set-3", workoutActivityID: "activity-1", setId: "set-3", movementId: "0b5e580d-f813-4f4e-81ae-2ed559f88a93", repCount: 12, avgWeight: 25, totalVolume: 300 },
        ],
      },
      "activity-2": {
        id: "activity-2",
        beginTime: "2026-04-04T12:00:00Z",
        totalDuration: 1750,
        totalVolume: 9500,
        workoutId: "workout-lower-1",
        programId: "program-b",
        workoutType: "Linear",
        workoutSetActivity: [
          { id: "set-4", workoutActivityID: "activity-2", setId: "set-4", movementId: "ef5f1802-a99e-4e56-b473-32bbf353fb73", repCount: 8, avgWeight: 70, totalVolume: 560 },
          { id: "set-5", workoutActivityID: "activity-2", setId: "set-5", movementId: "c7737825-dd6f-44b4-9b25-6ee66b43d07d", repCount: 10, avgWeight: 30, totalVolume: 300 },
        ],
      },
    },
  });

  it("selects an upper-biased session when upper lagging muscles dominate", () => {
    const plan = buildTonalSessionPlan({
      catalog,
      targetDate: "2026-04-06",
      athleteState: {
        readiness_band: "green",
        readiness_confidence: 0.9,
        phase_mode: "lean_gain",
      } as any,
      weeklyTrainingState: {
        confidence: 0.82,
        underdosed_muscles: { chest: {}, back: {}, biceps: {} },
        overdosed_muscles: { quads: {} },
        recommendation_summary: { mode: "volume_rise" },
        interference_risk_score: 55,
        fatigue_score: 6,
        phase_mode: "lean_gain",
      } as any,
    });

    expect(plan.sourceTemplateId).toContain("upper");
    expect(plan.planType).toBe("tomorrow");
    expect(plan.sessionBlocks[0]?.plannedMovements[0]?.movementId).toBeTruthy();
  });

  it("falls back to a recovery plan when readiness is red", () => {
    const plan = buildTonalSessionPlan({
      catalog,
      targetDate: "2026-04-06",
      athleteState: {
        readiness_band: "red",
        readiness_confidence: 0.8,
        phase_mode: "maintenance",
      } as any,
      weeklyTrainingState: {
        confidence: 0.72,
        underdosed_muscles: { chest: {} },
        overdosed_muscles: {},
        recommendation_summary: { mode: "deload" },
        interference_risk_score: 10,
        fatigue_score: 21,
        phase_mode: "maintenance",
      } as any,
    });

    expect(plan.planType).toBe("recovery_fallback");
    expect(plan.sourceTemplateId).toContain("recovery");
    expect(plan.confidence).toBeLessThan(0.85);
  });
});
