import { describe, expect, it } from "vitest";

import {
  buildTonalProgramCatalog,
  catalogMovementCandidatesForSlot,
} from "../../tools/fitness/tonal-program-catalog.ts";

describe("fitness tonal program catalog", () => {
  const payload = {
    profile: { userId: "user-1", totalWorkouts: 2 },
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
        ],
      },
      "activity-2": {
        id: "activity-2",
        beginTime: "2026-04-04T12:00:00Z",
        totalDuration: 1650,
        totalVolume: 9800,
        workoutId: "workout-lower-1",
        programId: null,
        workoutType: "Linear",
        workoutSetActivity: [
          { id: "set-3", workoutActivityID: "activity-2", setId: "set-3", movementId: "ef5f1802-a99e-4e56-b473-32bbf353fb73", repCount: 8, avgWeight: 70, totalVolume: 560 },
          { id: "set-4", workoutActivityID: "activity-2", setId: "set-4", movementId: "mystery-move", movementTitle: "Chaos Move", repCount: 12, avgWeight: 12, totalVolume: 144 },
        ],
      },
    },
    strength_scores: null,
  };

  it("builds a deterministic normalized catalog from tonal payloads", () => {
    const catalog = buildTonalProgramCatalog(payload);

    expect(catalog.userId).toBe("user-1");
    expect(catalog.summary.workoutsSeen).toBe(2);
    expect(catalog.summary.movementsSeen).toBe(4);
    expect(catalog.recentWorkouts[0]?.focus).toBe("lower");
    expect(catalog.workouts[0]?.qualityFlags).toContain("missing_program_id");
    expect(catalog.programs[0]?.programId).toBe("program-a");
    expect(catalog.movements.find((movement) => movement.movementId === "8edc0211-4594-4e5e-8e1b-b05dfc1d67c7")?.muscleGroup).toBe("chest");
    expect(catalog.qualityFlags.unmapped_movements).toContain("Chaos Move");
  });

  it("returns ranked movement candidates for planner slots", () => {
    const catalog = buildTonalProgramCatalog(payload);
    const candidates = catalogMovementCandidatesForSlot({
      catalog,
      targetMuscles: ["chest", "shoulders"],
      preferredPatterns: ["press"],
    });

    expect(candidates[0]?.movementId).toBe("8edc0211-4594-4e5e-8e1b-b05dfc1d67c7");
    expect(candidates[0]?.mapped).toBe(true);
  });
});
